# Conductor on Docker Swarm

Conductor has two orchestrator backends: **compose** (default, unchanged) and
**swarm**. The HTTP API and response shapes are the same in both modes, so the
Core Hub UI needs no change.

## Detecting the mode

`getOrchestrator()` (cached after the first successful call) decides once per
process:

1. `CONDUCTOR_ORCHESTRATOR=compose|swarm` forces the mode.
2. Otherwise Conductor inspects its own container (`os.hostname()` is the
   container id). If it carries `com.docker.swarm.service.name`, the mode is
   **swarm**, the stack namespace is its `com.docker.stack.namespace` label and
   its own service name is the swarm service name without the `<namespace>_`
   prefix.
3. Anything else (no label, inspect fails, not in a container) is **compose**.

In swarm mode `docker.info().Swarm.ControlAvailable` must be true: the Swarm
API (services, tasks, service logs) only answers on managers. On a worker,
every route except `/health` answers 503 with diagnosis `SWARM_NOT_MANAGER`.

## Stack file

The source of truth is the stack file in the root folder. The kit points
`DKR_COMPOSE_FILE` at it with an absolute path
(`/opt/gluesync-conductor/root-folder/docker-stack.yml`), so the compose file
helpers read and write it unchanged. Conductor reads it for the persisted `service` definitions and writes image
tags back to it after an update, so a later `docker stack deploy` does not
revert an update. Relative `file:` secrets/configs resolve against the root
folder, which is the kit directory on the manager.

Writes keep the file as it was: only the changed nodes are touched, and long
strings (a Traefik rule label, say) are written on one line, never folded
across lines (`lineWidth: 0`).

Environment interpolation: `docker stack deploy` does not read `.env`, so
Conductor exports `root-folder/.env` into the environment of the CLI it
spawns.

## Identity

A swarm service `<namespace>_<id>` is the Conductor service `id` (same ids as
in compose mode). Only services labelled `com.docker.stack.namespace=<ns>` are
considered. The Conductor type comes from the stack file service `labels` or
`deploy.labels` (`com.molo17.conductor.type`), then from the service spec
labels, then from the running task container labels.

When none of them carries the label, the type is worked out on read, the way
`autoAdoptServices` would have labelled the service in compose mode (the
shared `inferServiceType`): a stack service named `reverse-proxy`, `grafana`,
`prometheus` or `portainer` is `third-party`; otherwise the image name is
looked up in `agents.json` (`gluesync-core-hub` is `core-hub`, a source or
target connector is `agent`, Chronos and Conductor are `module`). An image that
is not in `agents.json` stays `unknown`. The stack file is never written for
this. It applies to `GET /containers` and to the types the update flow reads
from the stack file (`canUpdateContainers`, `prepareComposeUpdate`,
`editUpdateImagesInComposeFile`, the module discovery of the version route);
a label always wins over the inference.

## Startup

Swarm mode skips everything that edits the stack file or recreates containers
on its own: `autoAdoptServices`, `upAdoptedServices`, `healConductorConf` and
its `autoReboot`. `syncCollectLogsScripts` still runs (file copy only). The
update watchdog is not used: Swarm's own update monitor and rollback replace
it.

While the mode is undecided (the Docker daemon did not answer at startup),
startup retries detection for up to 60 s; if it is still unknown the compose
only healing is skipped with a warning. `POST /containers` and
`POST/PUT /services` answer 503 `DOCKER_NOT_READY` until the mode is known, and
container actions never fall back to compose.

## Shutdown

On SIGTERM or SIGINT (what Swarm and `docker stop` send) Conductor logs once,
closes the HTTP server (waiting at most 8 s) and exits 0, so it leaves inside
Docker's 10 s grace period instead of being killed (exit 137). A second signal
is ignored.

## Actions (`POST /containers`)

| Action | Swarm |
|---|---|
| start | scale to the stack file's `deploy.replicas` (default 1); if the service does not exist yet, `docker stack deploy` |
| stop | scale to 0 |
| restart | force update (`TaskTemplate.ForceUpdate + 1`), wait for convergence |
| restart, no ids | force update every stack service, Conductor last |
| kill | same as restart |
| pull | no-op success: Swarm pulls on update |
| update | a service already on the image of the stack file is not touched (any spec change is a rolling update in Swarm; `compose up` is a no-op there too) and reports `Service <id> is already on <image>.`; otherwise set the new image on the service with `UpdateConfig.FailureAction=rollback`, wait for `UpdateStatus` completed; on failure, roll back to the previous spec; write the new tag to the stack file on success |
| update of Conductor itself | reply first, then update its own service; Swarm replaces the task and rolls back if the new one fails; refused when it would be a downgrade (see below) |
| remove / undeploy | remove the service (undeploy also deletes it from the stack file) |
| removeNetwork | unchanged |
| migration to 2.x | refused (`SWARM_UNSUPPORTED`), both inside an update and on `POST /migrate-to-two` (501; 503 while the mode is unknown) |

### Conductor self-update guard

The Conductor's target version comes from the backoffice catalog
(`latestVersionGA`), which can be older than the running one: a GA without
Swarm support would come back compose-only and start editing and recreating
the stack. In swarm mode (never in compose) the Conductor therefore does not
update itself unless the target is greater, by semver, than the running
version (image tag, text after the first `-` ignored), and the running version
is a valid semver (a dev build such as `swarm-dev` is not). A target equal to
the running version is not an update.

A refused update is the item `{ id: <conductor>, status: 'ERROR', message }` of
the `POST /containers` reply (`checkModuleUpdate` reports it as `refusal` and
`needsUpdate: false`); the other services of the same request are updated as
usual, and a request that names only the Conductor updates nothing. An "update
all" reports the item too.

`GET /services/<conductor>/version` leaves out of `latestVersionAlpha`,
`latestVersionBeta`, `latestVersionGA` (and the changelog) a version that the
guard refuses, and the Conductor is not listed in `servicesToUpdate` /
`mandatoryUpdate` of the Core Hub version route in that case.

Restart with no ids and the update of other services never wait on the
Conductor: its own service is changed after the HTTP reply, without update mode
or watchdog. A failed update is rolled back with `docker service rollback`
unless Swarm already rolled it back (rolling back again would undo that). Images
are not pruned after an update: the Docker API only reaches the manager.

The stack file receives the Conductor's new image before Swarm replaces its
task. If Swarm rolls that back, the Conductor that starts again (the old image)
compares the stack file image with the image it is running and, when they
differ, writes the running image back (only that service; an image written as a
`${VAR}` is left alone) and logs a warning. It does so in any rollback state
(`rollback_started`, `rollback_paused`, `rollback_completed`): Swarm marks the
rollback completed only after its monitor window, so the service is usually
still `rollback_started` when the rolled back task boots. The running image is
read from the Conductor's own container (`Config.Image`, digest stripped); the
image of the service spec is used only when that inspect fails.

"Converged" means: `UpdateStatus.State` is `completed` (or absent for a
service never updated), the number of tasks in state `running` equals the
desired replicas, and that stays true for `UPDATE_VERIFY_SECONDS` (default 20)
within `UPDATE_VERIFY_MAX_WAIT_SECONDS` (default 180). `rollback_completed`,
`rollback_paused` or `paused` count as failure.

## Other routes

- `GET /containers`: one entry per stack service (`type` as under Identity); `info` is built from the
  newest running task (container id, node, state, image without digest) plus
  a `swarm` object `{ serviceId, node, replicas, desiredReplicas, updateState }`.
- `GET /services*`: read the stack file (long-syntax volumes/ports supported).
- `POST/PUT /services`: write the stack file; new services get
  `deploy.restart_policy.condition: on-failure` instead of `restart:`, no
  `container_name`/`depends_on`, network `gluesync-net`.
- Version routes: current tag from the service spec image (digest stripped).
- `POST /collect-logs`: `docker service logs` per stack service instead of
  `docker ps` / `docker logs` on the local node.

## Kit requirements

Conductor runs as a stack service on a manager (`node.role == manager`), with
`/var/run/docker.sock`, the kit directory bound as
`/opt/gluesync-conductor/root-folder`, and `DKR_COMPOSE_FILE` set to the stack
file's absolute path inside the container. One replica only.

The `docker` CLI (for `docker stack deploy` and `docker service logs`) is run by
absolute path, never looked up on `PATH`: `/usr/local/bin/docker`,
`/usr/bin/docker` or `/bin/docker` on Linux, `C:\Windows\System32\docker.exe`
(where the Windows image puts it) or `C:\Program Files\docker\docker.exe` on
Windows. `DOCKER_CLI_PATH` overrides them.
