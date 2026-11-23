import buildDiagnosis from '../../../diagnosis/buildDiagnosis';
import { ErrorResponse } from '../../../models/common.model';

/**
 * 501 for a route or action the Kubernetes mode does not serve yet (see
 * docs/kubernetes-mode.md). `feature` names it the way a caller wrote it:
 * `POST /containers (update)`, `GET /compose-to-json`.
 */
const buildUnsupportedOnKubernetesReply = (feature: string): ErrorResponse => ({
  success: false,
  error: `${feature} is not supported on Kubernetes yet`,
  details:
    'Conductor runs in Kubernetes mode, which does not serve this yet: nothing was changed',
  diagnosis: buildDiagnosis({
    code: 'KUBERNETES_UNSUPPORTED',
    params: { feature },
  }),
});

export default buildUnsupportedOnKubernetesReply;
