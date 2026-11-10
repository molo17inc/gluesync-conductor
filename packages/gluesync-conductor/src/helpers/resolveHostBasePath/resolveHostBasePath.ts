import { posix, win32 } from 'node:path';
import type Docker from 'dockerode';

import { getLogger } from '../../utils/logger';
import stripTrailingSlashes from '../../utils/stripTrailingSlashes';
import { isHelperKitDir } from '../autoReboot/windowsHelper';
import { KIT_DIR_IN_CONTAINER } from '../containerRuntime/composeEnv';
import { inspectSelf } from '../orchestrator/getOrchestrator/getOrchestrator';

// Compose sets it, on every container, to the project directory on the host
const WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';

const WINDOWS_KIT_DIR_IN_CONTAINER = String.raw`C:\opt\gluesync-conductor\root-folder`;

// Both forms count, whatever the platform node runs on: a Windows host path is
// absolute even when the Conductor itself uses posix path semantics
const isAbsoluteHostPath = (value: string): boolean =>
  posix.isAbsolute(value) || win32.isAbsolute(value);

const normalizeForCompare = (value: string): string =>
  stripTrailingSlashes(value.replaceAll('\\', '/')).toLowerCase();

const isKitDir = (destination: string): boolean =>
  [KIT_DIR_IN_CONTAINER, WINDOWS_KIT_DIR_IN_CONTAINER]
    .map(normalizeForCompare)
    .includes(normalizeForCompare(destination));

const hostPathFromInspect = (
  inspect: Readonly<Docker.ContainerInspectInfo>,
): string | undefined => {
  const label = inspect.Config?.Labels?.[WORKING_DIR_LABEL]?.trim();

  if (label && isAbsoluteHostPath(label)) {
    return label;
  }

  const source = inspect.Mounts?.find(
    mount => mount.Destination && isKitDir(mount.Destination),
  )?.Source?.trim();

  return source && isAbsoluteHostPath(source) ? source : undefined;
};

/**
 * BASE_PATH is the `--project-directory` of every compose command and helper
 * container the Conductor runs against the host. A kit started by hand has
 * `BASE_PATH=.`, which the daemon resolves against the Conductor's own cwd:
 * the bind sources do not exist on the host. This replaces anything that is not
 * an absolute host path with the project directory Docker recorded on this very
 * container. So does the helper's own mount point (`C:/update_context`), which
 * an older Restart all leaked into the recreated Conductor. Any other absolute
 * BASE_PATH is never touched, and it never throws.
 */
const resolveHostBasePath = async (docker: Readonly<Docker>): Promise<void> => {
  const current = process.env.BASE_PATH?.trim() ?? '';

  // C:/update_context is absolute but only exists inside a Windows helper
  // container: an older Restart all left it as this Conductor's BASE_PATH
  const helperInternal = isHelperKitDir(current);

  if (current && isAbsoluteHostPath(current) && !helperInternal) {
    return;
  }

  const logger = getLogger();

  try {
    const inspect = await inspectSelf(docker);
    const resolved = inspect && hostPathFromInspect(inspect);

    if (resolved) {
      // eslint-disable-next-line functional/immutable-data
      process.env.BASE_PATH = resolved;
      logger.info(
        `[base-path] BASE_PATH "${current}" is not ${helperInternal ? 'a host path (it is the update helper mount point)' : 'an absolute host path'}; using ${resolved} from the conductor container`,
      );
    } else {
      logger.warn(
        `[base-path] BASE_PATH "${current}" is not ${helperInternal ? 'a host path (it is the update helper mount point)' : 'an absolute host path'} and the host project directory could not be found on the conductor container: relative binds may not resolve`,
      );
    }
  } catch (error) {
    logger.warn(
      { error },
      '[base-path] could not inspect the conductor container to resolve BASE_PATH',
    );
  }
};

export default resolveHostBasePath;
