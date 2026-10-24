# Conductor sandbox

Runs the **real conductor** (built from this repo) against fake versions of every service in the default Docker kit, then drives 10–20 update cycles through it while injecting faults. Each run writes a report covering five areas: resilience, docker-compose rewrites, session handling, error handling and logging.

Nothing touches your own Docker. The whole sandbox runs inside one isolated Docker-in-Docker container. That matters, because after every update the conductor prunes **all** unused images on its host.

The runner calls the `docker` CLI by absolute path (`/usr/local/bin`, `/usr/bin` or `/bin`); set `SANDBOX_DOCKER_BIN` if yours lives elsewhere.

## Quick start

```bash
yarn install && yarn build          # repo root: builds packages/gluesync-conductor/build
cd sandbox && npm install
node run.mjs up                     # isolated daemon, registry, fakes, real conductor
node run.mjs iterate --iterations 17 --seed 4242
node run.mjs enospc                 # real-kernel ENOSPC test of safeWriteFile (sandbox must be up)
node run.mjs status
node run.mjs down --purge           # remove everything except reports/
```

Reports are written to `sandbox/reports/<timestamp>-seed<N>/`:

- `report.md`: summary, an iteration table and findings grouped by area
- `report.json`: everything, machine-readable
- `iter-NN-<profile>/`: the API transcript, compose file before and after, checks, and conductor and CoreHub log slices
- `logs/`: every conductor and CoreHub incarnation's docker logs, kept across container replacement

## What is real and what is fake

| Piece | In the sandbox |
|---|---|
| Conductor | **Real**: image built from `packages/gluesync-conductor/build`, re-tagged per version so it can self-update |
| CoreHub | Fake (`fakes/fake.mjs`, role `corehub`): WSS `/ext-module` handshake (Module-License / Module-Tag, token, ping/pong), `/authentication/login`, `/authentication/me`, `/authentication/logout`, sessions persisted across restarts |
| Chronos, agent, traefik, prometheus, grafana, portainer | Fake: same image names, labels, volumes and `command:` as the default kit, one tiny Node process each. The fake traefik forwards `/conductor/api/` to the conductor, as the real one does for the UI |
| api.backoffice.molo17.com | Fake, reached through the conductor's own `PROXY_HTTPS` support (an authenticating CONNECT proxy) and trusted with `NODE_EXTRA_CA_CERTS` |
| Docker Hub | Local registry `localhost:5000` inside the sandbox daemon; one image per service per version |
| Docker API | The conductor's `DOCKER_HOST` points at a pass-through socket proxy that can delay or refuse connections |

The kit (`kit/docker-compose.template.yml`) mirrors `debug-container/linux/docker-compose.yml`. It keeps the labels, the `$$` escapes, `sysctls`, `env_file` and the comment header, so that compose rewrite bugs show up.

## An iteration

1. Publish new versions of every service (`2.3.0.<100+i>`, `0.13.<100+i>`, …) to the registry and to the fake backoffice.
2. Apply the profile's fault. From here until the stack has settled, a sampler reads the compose file every ~25 ms (see *Compose file checks*).
3. Do what the UI does: read the containers, the services and every service's version, then send `POST /containers {action:update, ids:[]}` until everything is current. The conductor updates itself first, then Chronos, then everything else.
4. Clear the fault, wait for the stack to settle, then run the session probes.
5. Check the invariants (see `lib/checks.mjs`).

## Profiles (`lib/scenarios.mjs`)

| Profile | Fault |
|---|---|
| clean | none |
| backoffice-flaky | 2 × 503 per service, then recovery |
| backoffice-module-down | backoffice 500 for grafana only |
| backoffice-slow | backoffice takes 7s for core-hub (the conductor's timeout is 5s) |
| catalog-agent-mismatch | agent catalog one version behind core-hub |
| missing-image | prometheus target advertised but never pushed |
| bad-release | the new grafana image crash-loops |
| corehub-ws-drop | CoreHub drops the conductor WebSocket twice during the bulk update |
| corehub-auth-outage | `/authentication/me` returns 500 for 25s |
| corehub-down | CoreHub container stopped for 40s, including across the conductor's own restart |
| docker-socket-slow | 3s delay on every Docker API connection for 90s |
| docker-socket-blip | Docker API refuses connections for 10s; `/version` and `/containers` are called during the blip |
| concurrent-update | every update request is sent twice in parallel |
| conductor-crash-mid-update | SIGKILL right after the conductor rewrites the compose file; the compose must be valid right after the kill and after the restart |
| disk-full | the compose file's filesystem has 0 bytes free when the update is sent; the update must be refused with HTTP 507, `not enough free disk space` and `diagnosis.code` `DISK_FULL`, touching nothing; after the space is freed the retry updates everything |
| disk-almost-full | 32 KiB free: more than the compose file, less than the conductor's minimum (64 KiB in the sandbox); same expectation as disk-full |
| disk-flapping | during the bulk update the filesystem toggles between full and 96 KiB free every 20-50 ms; the UI-like driver keeps retrying; the compose is never blank or invalid, and after the filler stops the update converges |
| compose-blanked | the compose file is truncated to 0 bytes and the conductor restarted; within 60s it must restore it byte for byte from `.conductor/docker-compose.last-good.yml`, log `restored docker-compose.yml from last-good backup`, and never write a stub compose |
| full-restart | "restart all" (helper container: pull, down, up) |
| compose-customization | customer env var, `$$` label and comment added before the update |
| ui-sequence | no fault; drives the update like the Core Hub UI's modal instead of "update all": one request per service in the UI's order, through the reverse proxy, with the UI's auto-retries (3, after 2s/4s/8s), then a manual Retry if it halted (`lib/uiDriver.mjs`) |
| conductor-bad-release | *(only with `--destructive`)* the new conductor image crashes on start |

Pick profiles with `--profiles a,b`. Replay a run with the same `--seed`.

### Compose file checks (every profile)

- `compose.never-blank`: a background sampler reads the compose file the conductor sees every ~25 ms from before the profile's fault until the stack has settled. Every sample must be non-empty, parse, and contain every kit service. A sample that catches an in-flight write and is fine at the next one is counted as a torn read and ignored; two broken samples in a row, or an empty one, fail the check, with the samples as evidence.
- `compose.last-good-present`: `<kit>/.conductor/docker-compose.last-good.yml` exists, parses and has every service after each iteration (the conductor's backup of its last valid compose file).
- `compose.disk-full-refused` (disk profiles), `compose.blanked-restored` (compose-blanked), `compose.valid-after-crash` (conductor-crash-mid-update): see the profile table.

### How the disk faults work

The sandbox must never fill a real disk, and the conductor reads its compose file through a single-file bind mount (`./docker-compose.yml:/opt/gluesync-conductor/docker-compose.yml`), like the Linux kits. A disk profile therefore enters the conductor container's mount namespace from the privileged Docker-in-Docker container (`nsenter -t <pid> -m`, `lib/diskFault.mjs`) and, in there, mounts a 256 KiB tmpfs at `/run/sbx-disk`, copies the compose file into it, bind-mounts the copy over the compose file, and fills the tmpfs with a filler file down to the wanted free space. The conductor now sees a compose file on a tiny filesystem: statfs reports what is left, and a write that needs more fails with ENOSPC. For `disk-flapping` a loop in the same namespace creates and removes a second filler file every 20-50 ms.

On Docker Desktop for Mac (gRPC FUSE) the conductor's compose bind goes stale a few seconds after the compose file is written (by anyone; the host inode does not change) (its `mountinfo` root ends in `//deleted`) and the kernel then refuses the bind mount; the runner detects that, restarts the conductor container (same id, sandbox only) and notes it on the iteration. Native Linux binds never go stale.

While the fault is active the compose file in `run/kit` on the host is **not** what the conductor sees. The runner reads the conductor's copy through `/proc/<pid>/root` (the stream sampler) or `nsenter ... base64`. When the fault ends (always, in a `finally`-style release that `resetChaos` and the start of every iteration also run), the runner copies the conductor's bytes back to the host file in place (never truncating first, so no reader sees an empty file), unmounts the bind and the tmpfs, and the generic checks see the real file. If the conductor container was replaced meanwhile, its mounts went with it and there is nothing to undo. The fault is only injected when no conductor self-update is about to run (the self-update helper recreates the conductor from the host compose file): `disk-full` and `disk-almost-full` rely on the update being refused before anything is touched, `disk-flapping` starts when the bulk phase begins.

The kit's conductor runs with `CONDUCTOR_UPDATE_MIN_FREE_BYTES=65536` and `CONDUCTOR_WRITE_RESERVE_BYTES=4096` (sandbox-only; defaults are 512 MiB and 1 MiB) so a 256 KiB tmpfs is meaningful. They are part of the rendered kit compose file: use `node run.mjs up --fresh` after pulling this change.

## Real-kernel ENOSPC test (`node run.mjs enospc`)

`safeWriteFile`'s statfs pre-flight normally refuses a write before the kernel can return ENOSPC, and its unit tests use an in-memory fake fs. `enospc` exercises the real thing (`lib/enospc.mjs`, `lib/enospcDriver.cjs`):

1. Bundles `safeWriteFile.ts` and its imports to one CJS file with the repo's esbuild (resolved from `@gluesync/scripts` through Yarn PnP, as `buildService` does) into `run/enospc/`.
2. Runs it in a `--privileged` `node:24-alpine` container of the sandbox daemon (pulled on first use; the sandbox must be up). Inside, a 64 KiB tmpfs is mounted at `/small` and filled to 0 bytes free. `safeWriteFile` gets a real fs whose `statfs` rejects with `ENOSYS` (a supported production path), with `CONDUCTOR_WRITE_RESERVE_BYTES=0`, so the write itself meets the kernel's ENOSPC.

| Case | Setup | Expectation |
|---|---|---|
| A | `/small/compose.yml` (exactly 4096 and 8192 bytes of YAML) bind-mounted over `/target/compose.yml` on the overlay (separate mount, so the in-place strategy), content grows by a page | `DiskFullError`/ENOSPC with a kernel `write:ENOSPC` cause, bytes and inode identical |
| B | same mount, shrinking and same-size content | succeeds, file equals the new bytes |
| C | `/small/dir/compose.yml` directly on the tmpfs (replace strategy), bigger content | ENOSPC, old bytes intact, no `.compose.yml.*.tmp` left |
| D | control: case A with Node's plain `fs.writeFile` | file ends truncated (neither old nor new bytes); printed as `control: plain writeFile left N bytes`. Its expectation is inverted: it passes when the bug reproduces |

The runner prints a PASS/FAIL table, writes `reports/<timestamp>-enospc/report.md` and `report.json`, and exits non-zero if any case fails. If a case fails, check the `detail` object first: a `harness:` message means the setup, not `safeWriteFile`, is at fault.

## Ports (localhost only)

| Port | What |
|---|---|
| 23750 | sandbox Docker API (`DOCKER_HOST=tcp://127.0.0.1:23750 docker ps`) |
| 5317 | conductor API (`https`, sandbox CA in `run/kit/shared/sandbox-ca.pem`) |
| 5318 | fake CoreHub (log in with `admin`/`admin`, `viewer`/`viewer`, …) |
| 5319 | fake reverse proxy (`http`): `/conductor/api/...` reaches the conductor the way the UI does |
| 8088 | fake backoffice admin (`x-sandbox-admin` header) |
| 8089 | Docker socket proxy admin |
