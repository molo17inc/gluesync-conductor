# Conductor on Kubernetes

Conductor has a third orchestrator backend next to **compose** and **swarm**
(see [swarm-mode.md](./swarm-mode.md)): **kubernetes**. In this mode it runs as
a pod, uses no container engine and no compose file, and reads the workloads of
its own namespace from the Kubernetes API.

This is the first slice: **read-only**. Conductor starts, connects to Core Hub
and answers the routes that list services and versions, in the response shapes
of compose mode. Everything that changes something answers 501 (see
[What answers 501](#what-answers-501)). Compose and swarm are unchanged.

## Detecting the mode

The mode is decided once per process, from the environment alone, before
anything asks a container engine:

1. `CONDUCTOR_ORCHESTRATOR=kubernetes` forces it. `compose` or `swarm` rule it
   out, as before.
2. Otherwise it is **kubernetes** when both are true:
   - the process is in a pod: `KUBERNETES_SERVICE_HOST` is set and the service
     account token is mounted
     (`/var/run/secrets/kubernetes.io/serviceaccount/token`);
   - no container engine can be reached where the Docker client would connect:
     the address in `DOCKER_HOST`, else `CONTAINER_HOST`, else the well-known
     sockets (`/var/run/docker.sock`, Podman's). An address that names a socket
     or a named pipe only counts when that file exists (the image sets
     `DOCKER_HOST=unix:///var/run/docker.sock` whether or not the socket is
     mounted); a `tcp://` address always counts.
3. Anything else is detected as before (compose or swarm).

So a pod that mounts the node's Docker socket keeps the behaviour it had, and a
pod without one no longer crash-loops waiting for `/var/run/docker.sock`.

The namespace is `POD_NAMESPACE` when set, else the service account's
`namespace` file, else `default`. Conductor only ever reads that namespace.

## Startup

Kubernetes mode skips everything that needs the engine socket, the compose
file, the kit folder or a host path:

- the Docker plugin does not wait for a daemon;
- `BASE_PATH` is not resolved against the host;
- the compose file guard, `autoAdoptServices`, `upAdoptedServices`, the proxy
  error pages and Courier inbound healers, `healConductorConf` and its
  `autoReboot`, `syncCollectLogsScripts` and the update watchdog do not run.

The connection to Core Hub is the same as in the other modes. Set
`CORE_HUB_ADDRESS` to the Core Hub Service (`<release>-gluesync-core-hub`), so
that UDP discovery is not needed.

## Identity

Each StatefulSet and Deployment of the namespace is one Conductor service. Its
`id` is the Docker-style id callers already use, not the name of the object:

| Workload | `app.kubernetes.io/instance` | Conductor `id` |
|---|---|---|
| `gluesync-gluesync-core-hub` | `gluesync` | `gluesync-core-hub` |
| `prod-gluesync-chronos` | `prod` | `gluesync-chronos` |
| `prod-gluesync-conductor` | `prod` | `gluesync-conductor` |
| `prod-gluesync-grafana` | `prod` | `grafana` |
| `prod-gluesync-prometheus` | `prod` | `prometheus` |
| `my-tool` | (none) | `my-tool` |

The rule: the release name, read from the workload's
`app.kubernetes.io/instance` label, is taken off the front of the name
(`<release>-<id>`). The release is never assumed to be `gluesync`. The
third-party services the chart names `gluesync-grafana` and
`gluesync-prometheus` get the id they have in a Docker kit (`grafana`,
`prometheus`), which is what the version route of Core Hub looks for. A
workload without the label, or whose name does not start with the release,
keeps its name. If two workloads would get the same id (two releases in one
namespace), the first by kind and name keeps it and the others keep their full
name.

The `info.kubernetes` object of `GET /containers` carries the real names:
`{ kind, name, namespace, release, pod, node, replicas, desiredReplicas,
updatedReplicas, restarts }`.

The Conductor type follows the rules of a Docker kit: a third-party id
(`grafana`, `prometheus`, `reverse-proxy`, `portainer`) is `third-party`; then
the `com.molo17.conductor.type` label of the workload when it is a Conductor
type (`core-hub`, `module`, `agent`, `third-party`); then the image looked up
in `agents.json`; otherwise `unknown`. The chart labels Grafana and Prometheus
`module`: they are reported `third-party`, as in a Docker kit.

## What works

| Route | Kubernetes |
|---|---|
| `GET /health` | unchanged |
| `GET /connectivity` | unchanged (the registry probed is Docker Hub) |
| `GET /info` | `{ orchestrator: 'kubernetes', namespace, ServerVersion }` plus, when the node can be read, `Name`, `NCPU`, `MemTotal`, `OSType`, `Architecture`, `OperatingSystem`, `KernelVersion`, `ContainerRuntime` (the keys of Docker's `info`) |
| `GET /version` | the API server version under Docker's keys (`Version`, `GitCommit`, `GoVersion`, `Os`, `Arch`, `BuildTime`, `Platform.Name: Kubernetes`) plus `orchestrator` |
| `GET /containers` (and `type`) | one entry per workload: `service` is the workload (image, labels with the Conductor type, the environment values written in the manifest, `deploy.replicas`), `info` the pod shown (running first, then newest) with `info.kubernetes`; no `info` when the workload has no pod. `persisted` is always true |
| `GET /services`, `GET /services/:id` | the same `service` objects, with the filters of compose mode (`raw`, `format=string`) |
| `GET /services/:id/version/:releaseChannel?` | current version from the tag of the workload's image; latest versions, changelog and Core Hub's `servicesToUpdate` from the same catalog code as compose |
| `GET /disaster-recovery/setup` | `supported: false` with the reason, as on Swarm |

Notes:

- Environment values that come from a Secret, a ConfigMap or a field are not in
  the manifest and are left out. Values that are there are redacted for roles
  that cannot change the configuration, as in compose mode.
- A pod state is mapped onto the container states the UI knows: `running`,
  `created` (pending, pulling), `restarting` (`CrashLoopBackOff`), `exited`,
  `removing` (terminating). `info.status` has the Kubernetes reason.
- `systemInfo` (`ncpu`, `memTotal`) is the capacity of the node the Conductor
  pod runs on. Nodes are cluster-scoped, so this needs the optional ClusterRole
  below; without it both values are left out and the route still answers.
- A Kubernetes API error (a missing Role, say) answers 503
  `Kubernetes API unavailable` with the API's message in `details`.

## What answers 501

Every other route answers **501** before its handler runs, with the same body
everywhere:

```json
{
  "success": false,
  "error": "POST /containers (update) is not supported on Kubernetes yet",
  "details": "Conductor runs in Kubernetes mode, which serves the read-only routes only: nothing was changed",
  "diagnosis": { "code": "KUBERNETES_UNSUPPORTED", "params": { "feature": "POST /containers (update)" } }
}
```

`error` names the route as registered and, for `POST /containers`, the action.

- `POST /containers`, every action (`start`, `stop`, `restart`, `kill`, `pull`,
  `update`, `remove`, `undeploy`, `removeNetwork`)
- `POST /services`, `PUT /services`
- `POST /collect-logs`
- `POST /migrate-to-two`
- `GET /env/legacy-update`, `PUT /env/legacy-update`
- `GET /compose-to-json`
- `POST /disaster-recovery/setup/first`, `/setup/pairing-code`, `/setup/join`,
  `/disable`
- `GET /agents/:id/version/:releaseChannel?` (deprecated: use
  `/services/:id/version`)

The list is an allowlist of what is served (`plugins/kubernetesGuard.ts`): a
route added to the API later is refused on Kubernetes until it is listed there.
Authentication comes first (401 without a Core Hub session); an unknown path is
still a 404.

## RBAC

Conductor uses the service account of its pod: the token and the CA from
`/var/run/secrets/kubernetes.io/serviceaccount`, the API server from
`KUBERNETES_SERVICE_HOST` and `KUBERNETES_SERVICE_PORT`. This slice only reads,
so a namespaced Role is enough:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: gluesync-conductor
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: gluesync-conductor
rules:
  - apiGroups: ['apps']
    resources: ['statefulsets', 'deployments']
    verbs: ['get', 'list', 'watch']
  - apiGroups: ['']
    resources: ['pods']
    verbs: ['get', 'list', 'watch']
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: gluesync-conductor
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: gluesync-conductor
subjects:
  - kind: ServiceAccount
    name: gluesync-conductor
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gluesync-conductor
  labels:
    app.kubernetes.io/name: gluesync-conductor
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: gluesync-conductor
  template:
    metadata:
      labels:
        app.kubernetes.io/name: gluesync-conductor
    spec:
      serviceAccountName: gluesync-conductor
      containers:
        - name: gluesync-conductor
          image: molo17/gluesync-conductor:<version>
          env:
            # The Core Hub Service of the release
            - name: CORE_HUB_ADDRESS
              value: <release>-gluesync-core-hub
            - name: SSL_ENABLED
              value: 'true'
            - name: SSL_SKIP_VERIFY
              value: 'true'
            # Optional: the mode is detected in a pod without an engine socket
            - name: CONDUCTOR_ORCHESTRATOR
              value: kubernetes
          ports:
            - containerPort: 1717
          volumeMounts:
            # Keystore, license and security config shared with Core Hub
            - name: shared
              mountPath: /opt/gluesync/data
              readOnly: true
      volumes:
        - name: shared
          secret:
            secretName: <release>-gluesync-shared
```

No Docker socket, no hostPath, no privileged container.

`watch` is not used yet (every request lists); it is in the Role so that the
next slices, which wait for rollouts, need no RBAC change for reading.

### What node access would add

Reading nodes needs a ClusterRole, because nodes are not namespaced. It is
optional and only fills `systemInfo` (`ncpu`, `memTotal`) of `GET /containers`
and the host fields of `GET /info`:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: gluesync-conductor-node-reader
rules:
  - apiGroups: ['']
    resources: ['nodes']
    verbs: ['get']
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: gluesync-conductor-node-reader
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: gluesync-conductor-node-reader
subjects:
  - kind: ServiceAccount
    name: gluesync-conductor
    namespace: <namespace>
```

Without it the API answers 403 for the node, which Conductor remembers for five
minutes before asking again.

## Kubernetes client

`helpers/kubernetes/kubernetesClient` is a small read-only client on Node's
`https`: no dependency was added. It reads the token on every call (the kubelet
rotates it), verifies the API server against the mounted CA, and times out
after 10 s. Three list calls (StatefulSets, Deployments, Pods) serve a request,
whatever the number of workloads; pods are matched to a workload by its
`spec.selector.matchLabels`.

## Next slices

1. **Update**: set the image of a workload, wait for the rollout
   (`updatedReplicas`, `readyReplicas`, the rollout status), roll back to the
   previous image when it does not converge; Core Hub's pipeline maintenance
   around it, as in compose and swarm. Needs `patch` on StatefulSets and
   Deployments.
2. **Restart**: a rollout restart (the `kubectl.kubernetes.io/restartedAt`
   annotation), Conductor last.
3. **Stop and start** by scaling to 0 and back to the previous replica count.
4. **Self-update**: Conductor changes its own Deployment after replying, with
   the downgrade guard of swarm mode.
5. **Pod logs** for `POST /collect-logs` (`pods/log`).
6. **State storage**: what the compose kit keeps in the root folder (paused
   pipelines of an interrupted update, backups), in a ConfigMap or a volume.

Still open after those: adding and editing services (`POST`/`PUT /services`),
disaster recovery, and the registries of the workloads in `GET /connectivity`.
