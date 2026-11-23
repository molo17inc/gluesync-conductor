/** The actions of `POST /containers` the Kubernetes mode runs; the others answer 501. */
const KUBERNETES_CONTAINER_ACTIONS: ReadonlySet<string> = new Set([
  'update',
  'restart',
]);

export default KUBERNETES_CONTAINER_ACTIONS;
