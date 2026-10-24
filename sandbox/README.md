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
node run.mjs iterate --profiles all --shard 2/4   # every profile once, a quarter of them (what a CI job runs)
node run.mjs disk-check             # inject each disk fault, verify it from the conductor's side, release it (sandbox must be up)
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

`--profiles all` runs every non-destructive profile once, in the order of the table, minus `--exclude a,b` and `SANDBOX_EXCLUDE_PROFILES` (comma separated; an unknown name is an error). `--shard i/n` (1-based) keeps the profiles at positions `k` of that list with `k % n == i-1`, and implies `--profiles all`; `--iterations` is ignored for `all` and for a shard. `iterate` exits 1 if any iteration FAILs (WARN does not), and writes `junit.xml` next to `report.md`: one test case per iteration, named after the profile.

### Compose file checks (every profile)

- `compose.never-blank`: a background sampler reads the compose file the conductor sees every ~25 ms from before the profile's fault until the stack has settled. Every sample must be non-empty, parse, and contain every kit service. A sample that catches an in-flight write and is fine at the next one is counted as a torn read and ignored; two broken samples in a row, or an empty one, fail the check, with the samples as evidence.
- `compose.last-good-present`: `<kit>/.conductor/docker-compose.last-good.yml` exists, parses and has every service after each iteration (the conductor's backup of its last valid compose file).
- `compose.disk-full-refused` (disk profiles), `compose.blanked-restored` (compose-blanked), `compose.valid-after-crash` (conductor-crash-mid-update): see the profile table.

### How the disk faults work

The sandbox must never fill a real disk, and the conductor reads its compose file through a single-file bind mount (`./docker-compose.yml:/opt/gluesync-conductor/docker-compose.yml`), like the Linux kits. A disk profile therefore enters the conductor container's mount namespace from the privileged Docker-in-Docker container (`nsenter -t <pid> -m`, `lib/diskFault.mjs`) and, in there, mounts a 256 KiB tmpfs at `/run/sbx-disk`, copies the compose file into it, bind-mounts the copy over the compose file, and fills the tmpfs with a filler file down to the wanted free space (nothing in there reads `/proc` or runs `df`: inside the conductor's mount namespace `/proc` is the container's own, and `df` printed nothing on the CI runner, which once made the fault silently ineffective). The runner then **verifies** the fault from the Docker-in-Docker container, through `/proc/<pid>/mountinfo` and statfs on `/proc/<pid>/root/...`: exactly one tmpfs bind mount over the compose file, the file on a tmpfs, the free space that was asked for, the host's bytes. If any of that is not true it throws, with diagnostics (kernel, mount table, statfs, what `df` says in there), and the iteration fails with that message instead of a misleading disk-full result; `node run.mjs disk-check` runs the same checks for each kind of fault. The conductor now sees a compose file on a tiny filesystem: statfs reports what is left, and a write that needs more fails with ENOSPC. For `disk-flapping` a loop in the same namespace creates and removes a second filler file every 20-50 ms.

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

## In CI

The `sandbox` job of `.gitlab-ci.yml` runs on every merge request pipeline (no manual step), on the `hq-linux-docker` runners, after `build_artifacts` (it needs `packages/gluesync-conductor/build`). It is `parallel: 4`: shard `i` runs `node run.mjs iterate --profiles all --shard i/4`, one iteration per profile, so about five profiles each; shard 1 also runs `node run.mjs enospc`. The job fails if any iteration or ENOSPC case fails. Reports (with `junit.xml`, shown as the pipeline's test report) are kept as artifacts for two weeks.

- **Own daemon.** The job runs in a privileged container (the CI image below, which is `docker:28.3.3-dind` plus tooling) and starts its own `dockerd` there (data root on the image's `/var/lib/docker` volume, never overlay on overlay). Concurrent pipelines never share a daemon, so there is nothing to clash on names or ports, and the bind-mount paths under the checkout exist for the daemon that mounts them. The sandbox then runs its own DinD inside that daemon, exactly as on a Mac.
- **Excluded:** destructive profiles, and `conductor-crash-mid-update`, which can deadlock: a SIGKILL in the middle of the recreate leaves CoreHub `Created`, and the restarted conductor's SDK plugin blocks startup until CoreHub answers, so it crash-loops. Known bug; re-enable it by emptying `SANDBOX_EXCLUDE_PROFILES` in `ci/sandbox-job.sh`.
- **No signing, no registry credentials**: nothing leaves the job except the artifacts.
- **Nothing from Docker Hub, nothing from npm.** The job image is `nexus.hq.molo17.com/molo17-local/conductor-sandbox-ci:1` (`ci/sandbox-ci.Dockerfile`): `docker:28.3.3-dind` plus node, corepack with yarn prepared, and the sandbox's npm dependencies in `/opt/sandbox-deps` (the job symlinks `sandbox/node_modules` to it). `COREPACK_ENABLE_NETWORK=0` makes a yarn download fail instead of happen; `ci/sandbox-job.sh` fails if node, yarn or the deps are missing, or if `sandbox/package-lock.json` is not the one the image was built from. The sandbox's own images come from Nexus too, through `SANDBOX_IMAGE_MIRROR` (below). The one download left is the conductor image's own `apk add` (`packages/gluesync-conductor/Dockerfile`), from the Alpine CDN: not Docker Hub, not rate-limited.

### Image mirror (`SANDBOX_IMAGE_MIRROR`)

Unset (a developer's Mac), every image comes from Docker Hub on first use. Set it to a registry/repository, e.g. `nexus.hq.molo17.com/molo17-local` (the job does), and the sandbox pulls `<mirror>/<name:tag>` instead and tags it with the canonical Docker Hub name before anything uses it, in the daemon that uses it (`seedImages` in `lib/setup.mjs`, the list is `requiredImages` in `lib/env.mjs`):

| Daemon | Images |
|---|---|
| host (the job's own `dockerd`, or Docker Desktop) | `docker:28.3.3-dind` (the sandbox DinD, and the certificate step, which uses its `openssl`) |
| sandbox (inside the DinD) | `registry:2.8.3`, `node:24.16.0-alpine` (FROM of the fakes and of the conductor image, and the ENOSPC test), `alpine:3.20` (nsenter fallback of the disk-full fault), `docker:28` and `docker:cli` (the helper images the conductor itself runs for self-update and "restart all"; it pulls them from Docker Hub when absent) |

`up` also creates a stopped `keep-*` container per image, because the conductor prunes every unused image after an update and would otherwise delete the seeded helpers. Because the names are canonical and present, `docker build` (no `--pull`) uses the local image for `FROM` without contacting a registry, so neither Dockerfile needed changes for that. The fakes' `ws` package comes from the sandbox's own npm dependencies (staged into the build context), not from `npm install` in the image build. The mirror must hold every name above with the same tag; mirror a new image there before adding it to `requiredImages`.

`SANDBOX_DIND_ADD_HOSTS="host:ip,host:ip"` adds `--add-host` entries to the sandbox DinD, to prove the nested daemon never reaches a host (for example `registry-1.docker.io:127.0.0.1`); add the same `--add-host` flags to the outer `docker run` for the job container's own daemon.

### The CI image

Rebuild and push it when `ci/sandbox-ci.Dockerfile`, `sandbox/package.json`, `sandbox/package-lock.json` or the root `packageManager` change, and bump the tag (`:1` is the current one) in the Dockerfile header, in `.gitlab-ci.yml` and here. From the repository root, logged in to Nexus:

```bash
docker buildx build --platform linux/amd64,linux/arm64 --provenance=false --sbom=false \
  -f ci/sandbox-ci.Dockerfile --build-arg SOURCE_COMMIT=$(git rev-parse --short HEAD) \
  -t nexus.hq.molo17.com/molo17-local/conductor-sandbox-ci:1 --push .
docker buildx imagetools inspect nexus.hq.molo17.com/molo17-local/conductor-sandbox-ci:1
```

The build fails if `YARN_VERSION` (build arg, default `4.6.0`) differs from the root `packageManager`.

Everything the job does is in `ci/sandbox-job.sh`. To reproduce shard 2 of 4 locally, in the same image and with the same mirror, from a copy of the checkout (run `yarn install && yarn build` first):

```bash
docker run --rm --privileged --entrypoint sh \
  -v "$PWD":/src:ro -v /tmp/sandbox-out:/out \
  -e CI_NODE_INDEX=2 -e CI_NODE_TOTAL=4 \
  -e SANDBOX_NAME=conductor-sandbox-ci -e SANDBOX_PORT_OFFSET=1000 \
  -e SANDBOX_IMAGE_MIRROR=nexus.hq.molo17.com/molo17-local \
  nexus.hq.molo17.com/molo17-local/conductor-sandbox-ci:1 -c '
    mkdir -p /builds/conductor && cd /builds/conductor
    tar -C /src --exclude=./.git --exclude=./sandbox/node_modules --exclude=./sandbox/run --exclude=./sandbox/reports -cf - . | tar -xf -
    sh ci/sandbox-job.sh; rc=$?
    cp -a sandbox/reports/. /out/
    exit $rc'
```

`ci/sandbox-job.sh` gives each phase a time budget (`SANDBOX_UP_BUDGET` 600 s, `SANDBOX_ITERATE_BUDGET` 2400 s, `SANDBOX_ENOSPC_BUDGET` 420 s, `SANDBOX_TEARDOWN_BUDGET` 90 s) and the sandbox gives every docker command its own timeout, so a hang fails the job with a message (`... hung: killed after Ns`) well before the job's 60 minutes. `up` and `iterate` wait until the fake CoreHub accepts a TLS login, the fake backoffice and docker proxy answer and the conductor is healthy before they use them (`waitStackReady`): `docker compose up -d` returns before the fakes listen, and a slower host hits that window. `SANDBOX_JOB_ONLY=disk-check` runs only `up` and `disk-check`, to diagnose a runner quickly.

It never touches your own sandbox: the nested daemon is private to the container, and `SANDBOX_NAME` / `SANDBOX_PORT_OFFSET` only matter when you run `ci/sandbox-job.sh` directly on a host that already runs one.

## Overriding names and ports

Defaults are listed under *Ports*. `SANDBOX_NAME` (default `conductor-sandbox`) names the DinD container and its volume (`<name>-dind`). `SANDBOX_PORT_OFFSET` is added to every default port; `SANDBOX_DOCKER_PORT`, `SANDBOX_CONDUCTOR_PORT`, `SANDBOX_COREHUB_PORT`, `SANDBOX_PROXY_PORT`, `SANDBOX_BACKOFFICE_ADMIN_PORT` and `SANDBOX_DOCKER_PROXY_ADMIN_PORT` set one port and win over the offset. Names inside the sandbox daemon (images, `keep-*` helpers, the infra compose project) cannot clash with anything on the host and are fixed.

## Ports (localhost only)

| Port | What |
|---|---|
| 23750 | sandbox Docker API (`DOCKER_HOST=tcp://127.0.0.1:23750 docker ps`) |
| 5317 | conductor API (`https`, sandbox CA in `run/kit/shared/sandbox-ca.pem`) |
| 5318 | fake CoreHub (log in with `admin`/`admin`, `viewer`/`viewer`, …) |
| 5319 | fake reverse proxy (`http`): `/conductor/api/...` reaches the conductor the way the UI does |
| 8088 | fake backoffice admin (`x-sandbox-admin` header) |
| 8089 | Docker socket proxy admin |
