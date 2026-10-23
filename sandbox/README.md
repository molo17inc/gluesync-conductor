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
2. Apply the profile's fault.
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
| conductor-crash-mid-update | SIGKILL right after the conductor rewrites the compose file |
| full-restart | "restart all" (helper container: pull, down, up) |
| compose-customization | customer env var, `$$` label and comment added before the update |
| ui-sequence | no fault; drives the update like the Core Hub UI's modal instead of "update all": one request per service in the UI's order, through the reverse proxy, with the UI's auto-retries (3, after 2s/4s/8s), then a manual Retry if it halted (`lib/uiDriver.mjs`) |
| conductor-bad-release | *(only with `--destructive`)* the new conductor image crashes on start |

Pick profiles with `--profiles a,b`. Replay a run with the same `--seed`.

## Ports (localhost only)

| Port | What |
|---|---|
| 23750 | sandbox Docker API (`DOCKER_HOST=tcp://127.0.0.1:23750 docker ps`) |
| 5317 | conductor API (`https`, sandbox CA in `run/kit/shared/sandbox-ca.pem`) |
| 5318 | fake CoreHub (log in with `admin`/`admin`, `viewer`/`viewer`, …) |
| 5319 | fake reverse proxy (`http`): `/conductor/api/...` reaches the conductor the way the UI does |
| 8088 | fake backoffice admin (`x-sandbox-admin` header) |
| 8089 | Docker socket proxy admin |
