# Conductor on Podman

Conductor runs on Podman 4.9 and later, rootful and rootless, on Linux. It
talks to Podman through its Docker-compatible API socket and drives the stack
with `docker compose` v2 (the same implementation it uses on Docker), not with
`podman-compose`. The HTTP API and response shapes are the same on both engines.

Out of scope: Docker Swarm (Podman has no Swarm mode, see
[Unsupported](#unsupported)) and Windows containers.

## Host prerequisites

- The Podman API socket must be running:
  - rootful: `systemctl enable --now podman.socket`
  - rootless: `systemctl --user enable --now podman.socket` and
    `loginctl enable-linger <user>` (so it outlives the login session)
- Rootless: the kit publishes ports 80 and 443, which an unprivileged user may
  only bind with `net.ipv4.ip_unprivileged_port_start=80` (or lower).
- `docker compose` v2 on the host, to bring the kit up the first time (the
  Conductor image carries its own).
- SELinux hosts (RHEL, Rocky, Fedora): nothing to switch off, the kit uses
  `:z` volume options and `label=disable` for the socket, see
  [SELinux](#selinux).

## Which socket

The path that matters is the one on the **host**: the Conductor starts helper
containers (self update, restart of the whole stack) with
`-v <host socket>:/var/run/docker.sock`, and that source is resolved by the host's
engine, not inside the Conductor container. Inside every container the socket
is always `/var/run/docker.sock`.

| Engine              | Host socket                              | `GS_CONTAINER_SOCKET`                    |
| ------------------- | ---------------------------------------- | ---------------------------------------- |
| Docker              | `/var/run/docker.sock`                   | unset (default)                          |
| Podman, rootful     | `/run/podman/podman.sock`                | `/run/podman/podman.sock`                |
| Podman, rootless    | `/run/user/<uid>/podman/podman.sock`     | `/run/user/<uid>/podman/podman.sock`     |

Conductor resolves the host socket in this order:

1. `GS_CONTAINER_SOCKET` in its environment;
2. the source of the bind mount its own container has on
   `/var/run/docker.sock` (read from the engine, `Mounts[]` of its own
   inspect);
3. `/var/run/docker.sock`.

Outside a container (a development run) the client probes, in order:
`DOCKER_HOST`, `CONTAINER_HOST` (`unix://` or `tcp://`), then the sockets
`/var/run/docker.sock`, `/run/podman/podman.sock` and
`$XDG_RUNTIME_DIR/podman/podman.sock`.

## The kit `.env`

The installer (or Gluesync Control) writes these keys to the `.env` next to the
kit's `docker-compose.yml`:

| Key                    | Value                                                                 |
| ---------------------- | --------------------------------------------------------------------- |
| `GS_CONTAINER_SOCKET`  | Host path of the engine socket (table above). Unset on Docker.        |
| `GS_COREHUB_USERNS`    | Rootless Podman only: `keep-id:uid=1017,gid=1017`. Unset otherwise.   |
| `GS_CONTAINER_RUNTIME` | `docker` or `podman`. Informational: Conductor detects the engine itself. |

The kit's compose file uses them as
`${GS_CONTAINER_SOCKET:-/var/run/docker.sock}:/var/run/docker.sock` on every
service that mounts the socket, and `userns_mode: ${GS_COREHUB_USERNS:-}` on
Core Hub (an empty value is dropped by compose, so Docker is unaffected).

`BASE_PATH` (the `--project-directory` Conductor gives compose) is a host path
that usually does not exist inside the Conductor container, so compose would
never find the `.env` next to it. Conductor therefore passes
`--env-file /opt/gluesync-conductor/root-folder/.env` to every compose command it
runs, and, when neither that file nor its own environment sets
`GS_CONTAINER_SOCKET`, adds the socket it resolved above to the compose
environment. A recreate of the Conductor, the proxy or Core Hub started from
Conductor keeps the socket mount and the user namespace. The self-update and
full-restart helpers read the same `.env` (the kit directory is mounted in them)
and get `-e GS_CONTAINER_SOCKET=...` when it lacks the key.

## SELinux

On an SELinux host every bind mount needs a relabel option, and a container that
mounts the engine socket needs its label confinement off:

- `:z` on every relative bind (`:ro,z` when read-only), never on the socket;
- `security_opt: [label=disable]` on the services that mount the socket;
- helper containers started by Conductor get `--security-opt label=disable`
  (harmless on Docker).

When Conductor writes a service it keeps the SELinux options of a volume: `z`,
`Z`, alone or with the access mode (`ro,z`, `rw,Z`; the access mode comes
first). Any other option is dropped, as before. The default agent folders it
generates are `./logs/<id>:/opt/gluesync/logs:z` and
`./data/<id>:/opt/gluesync/data:z` (not on Windows, not on Swarm).

Podman also refuses to start a container whose bind source folder is missing
(Docker creates it). Before `compose up` Conductor creates the missing relative
bind folders of the service under the kit directory
(`/opt/gluesync-conductor/root-folder`), as the Conductor user, and never
changes their owner.

## Rootless notes

- Core Hub's entrypoint changes the owner of its data to uid 1017; in a rootless
  user namespace that uid maps to a sub-uid the host user cannot read.
  `GS_COREHUB_USERNS=keep-id:uid=1017,gid=1017` makes the container start as
  uid 1017, which needs a Core Hub image whose entrypoint also works when it
  does not start as root.
- Podman's default networks are `10.88.0.0/16` and `10.89.x.0/24`. A service
  that only accepts `127.*`, `172.*` and `192.168.*` callers sees a proxied call
  from there as foreign.

## What Conductor does differently on Podman

- **Engine detection.** From `GET /version` (`Components[].Name` containing
  `Podman Engine`) and `GET /info` (`SecurityOptions` containing `name=rootless`)
  Conductor works out `{ engine: "docker" | "podman", rootless, version }`,
  once per process. The Conductor's own `GET /version` and `GET /info` answer
  with it in an additional `data.containerEngine` field.
- **Image names.** Podman reports `docker.io/molo17/x:1` and
  `docker.io/library/busybox:1.36` where Docker reports what was written
  (`molo17/x:1`, `busybox:1.36`). Conductor compares and reports images by their
  short form (`docker.io/`, `index.docker.io/` and `library/` are removed), so a
  plain `molo17/...` image has no registry in `parsedImage` and a rollback does
  not take a running service for one on another image. Lookups by image
  accept either spelling.
- **Helper images** are fully qualified (`docker.io/library/docker:cli`,
  `docker.io/library/docker:28`): on RHEL-like hosts Podman refuses a short name
  without a terminal. They mean the same image on Docker.
- **Registry lookups.** Podman's compatibility API has no
  `GET /distribution/{name}/json` (404). When the engine answers 404 or 501,
  Conductor asks Docker Hub itself with a manifest `HEAD` (anonymous pull token
  from `auth.docker.io`, through the proxy settings the other outbound calls
  use) for Docker Hub images. This keeps the Chronos `-debian` choice on an
  older CPU working.
- **Diagnostics.** `collect-logs` labels its report as Podman and does not count
  the commands Podman lacks (`docker stats`, the standalone `docker-compose`)
  as failures.
- Container lists tolerate what Podman leaves out (`HostConfig.NetworkMode`,
  `NetworkSettings.Networks`). A connection error mentioning `podman.sock` is
  treated as a Docker outage, like one mentioning `docker.sock`.

## Unsupported

- **Docker Swarm.** Podman has no Swarm mode. With `CONDUCTOR_ORCHESTRATOR=swarm`
  on Podman, every route except `/health` answers `501` with diagnosis
  `SWARM_UNSUPPORTED_ON_PODMAN`, and no action runs. Leave
  `CONDUCTOR_ORCHESTRATOR` unset or set it to `compose`.
- Windows containers (Podman cannot run them).
- `podman-compose`: the kit is driven by `docker compose` v2 against the Podman
  socket (`DOCKER_HOST=unix://<socket>`).
