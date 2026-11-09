import { getLogger } from '../../utils/logger';
import { spawnAsync } from './autoReboot';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import { getDocker } from '../../utils/docker/getDocker';
import { helperSocketEnvArgs } from '../containerRuntime/composeEnv';
import { HELPER_IMAGE_28 } from '../containerRuntime/helperImages';
import {
  ENGINE_SOCKET_IN_CONTAINER,
  resolveHostSocketPath,
} from '../containerRuntime/hostSocketPath';

type AutoReboot = (
  options: Readonly<{
    hostProjectDir: string;
    serviceName: string;
    helperImage: string;
    rollbackImage?: string;
  }>,
) => Promise<boolean>;

const logger = getLogger();

// Runs inside the helper container, which outlives the conductor it replaces,
// so its progress goes to ./logs (mounted by the conductor and collected by
// collect-logs) as well as to the conductor that started it.
//
// With ROLLBACK_IMAGE set, the new container must stay running without a
// restart for 30s (within 2 minutes); otherwise the service's image line in
// the compose file goes back to ROLLBACK_IMAGE and the service is recreated.
const SELF_UPDATE_SCRIPT = `
set -u
mkdir -p logs
LOG=logs/conductor-self-update.log
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [self-update] $*" | tee -a "$LOG"; }

log "recreating $SVC"
UP_FAILED=0
if ! docker compose up -d --force-recreate "$SVC" >>"$LOG" 2>&1; then
  log "docker compose up failed for $SVC"
  UP_FAILED=1
fi
[ -z "\${ROLLBACK_IMAGE:-}" ] && exit $UP_FAILED

stable=0; i=0; last=""
while [ $i -lt 60 ]; do
  sleep 2; i=$((i + 1))
  cid=$(docker compose ps -a -q "$SVC" 2>/dev/null | head -n 1)
  [ -z "$cid" ] && continue
  last=$(docker inspect -f '{{.State.Status}} {{.RestartCount}} {{.State.ExitCode}}' "$cid" 2>/dev/null)
  status=$(echo "$last" | cut -d' ' -f1); restarts=$(echo "$last" | cut -d' ' -f2)
  if [ "$restarts" != "0" ] || [ "$status" = "exited" ] || [ "$status" = "dead" ] || [ "$status" = "restarting" ]; then
    break
  fi
  [ "$status" = "running" ] && stable=$((stable + 1)) || stable=0
  if [ $stable -ge 15 ]; then
    log "$SVC is up on $NEW_IMAGE"
    exit 0
  fi
done

log "$SVC did not stay up on $NEW_IMAGE (status/restarts/exit: $last); rolling back to $ROLLBACK_IMAGE"
FILE=""
for f in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
  [ -f "$f" ] && FILE="$f" && break
done
if [ -z "$FILE" ]; then
  log "no compose file found, cannot roll back"
  exit 1
fi
NEW_RE=$(printf '%s' "$NEW_IMAGE" | sed 's/[.[*^$\\\\]/\\\\&/g')

# Rewrites $FILE in place without ever truncating it first: the conductor mounts
# this single file (a new inode would go unseen), and "cat >" emptied it when
# the disk was full. The file is padded with newlines to the longer of the old
# and new sizes, the new bytes go over it, then it is cut to the new size, so
# every state in between is a complete compose file.
size_of() { wc -c < "$1" | tr -d ' '; }
pad() { [ "$1" -gt 0 ] || return 0; yes '' | head -c "$1"; }
no_room() { log "rollback not applied: not enough free disk space"; }
undo() {
  dd if=/tmp/compose.before of="$FILE" conv=notrunc 2>/dev/null
  truncate -s "$old_size" "$FILE"
}
apply_rollback() {
  [ -s /tmp/compose.rollback ] || { log "rollback not applied: the rewritten compose file is empty"; return 1; }
  cmp -s "$FILE" /tmp/compose.rollback && return 0
  old_size=$(size_of "$FILE"); new_size=$(size_of /tmp/compose.rollback)
  len=$old_size
  [ "$new_size" -gt "$len" ] && len=$new_size
  cp "$FILE" /tmp/compose.before 2>/dev/null || { no_room; return 1; }
  cp /tmp/compose.rollback /tmp/compose.padded 2>/dev/null \\
    && pad $((len - new_size)) >> /tmp/compose.padded 2>/dev/null \\
    || { no_room; return 1; }
  if [ "$len" -gt "$old_size" ]; then
    pad $((len - old_size)) >> "$FILE" 2>/dev/null
    if [ "$(size_of "$FILE")" != "$len" ]; then undo; no_room; return 1; fi
  fi
  if ! dd if=/tmp/compose.padded of="$FILE" conv=notrunc 2>/dev/null \\
    || ! truncate -s "$new_size" "$FILE" \\
    || ! cmp -s /tmp/compose.rollback "$FILE"; then
    undo
    log "rollback not applied: could not write $FILE"
    return 1
  fi
}

if ! sed "s|image: *[\\"']\\{0,1\\}$NEW_RE[\\"']\\{0,1\\} *$|image: $ROLLBACK_IMAGE|" "$FILE" > /tmp/compose.rollback; then
  no_room
elif ! apply_rollback; then
  :
elif grep -q "image: $ROLLBACK_IMAGE" "$FILE"; then
  docker compose up -d --force-recreate "$SVC" >>"$LOG" 2>&1 \\
    && log "rolled back $SVC to $ROLLBACK_IMAGE" \\
    || log "rollback of $SVC to $ROLLBACK_IMAGE failed"
else
  log "could not find image $NEW_IMAGE in $FILE, rollback not applied"
fi
exit 1
`;

const currentImageOf = async (serviceName: string): Promise<string> => {
  try {
    const compose = await readComposeFile({ raw: true });
    return compose.services?.[serviceName]?.image ?? '';
  } catch {
    return '';
  }
};

const autoRebootLinux: AutoReboot = async ({
  hostProjectDir,
  serviceName = 'gluesync-conductor',
  helperImage = HELPER_IMAGE_28, // image with docker CLI + compose plugin
  rollbackImage,
}) => {
  if (!hostProjectDir) {
    throw new Error('hostProjectDir is required');
  }

  const newImage = rollbackImage ? await currentImageOf(serviceName) : '';
  const withRollback =
    !!rollbackImage && !!newImage && newImage !== rollbackImage;

  // The `-v` source is resolved by the HOST engine: on Podman the socket is not
  // at /var/run/docker.sock. label=disable lets the helper use it on SELinux.
  const docker = getDocker();
  const hostSocket = await resolveHostSocketPath(docker);

  const args: ReadonlyArray<string> = [
    'run',
    '--rm',
    '--security-opt',
    'label=disable',
    '-v',
    `${hostSocket}:${ENGINE_SOCKET_IN_CONTAINER}`,
    '-v',
    `${hostProjectDir}:${hostProjectDir}`,
    '-w',
    hostProjectDir,
    ...(await helperSocketEnvArgs(docker)),
    '-e',
    `SVC=${serviceName}`,
    '-e',
    `NEW_IMAGE=${withRollback ? newImage : ''}`,
    '-e',
    `ROLLBACK_IMAGE=${withRollback ? rollbackImage : ''}`,
    helperImage,
    'sh',
    '-c',
    SELF_UPDATE_SCRIPT,
  ];

  logger.info(
    {
      serviceName,
      newImage: newImage || undefined,
      rollbackImage: withRollback ? rollbackImage : undefined,
    },
    '[conductor-updater] starting helper to recreate the service',
  );
  await spawnAsync('docker', args);
  return true;
};

export default autoRebootLinux;
