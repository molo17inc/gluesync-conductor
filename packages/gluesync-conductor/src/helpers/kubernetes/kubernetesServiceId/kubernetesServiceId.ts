import { LabelPrefix } from '../../../models/composeFile.model';
import { ConductorServiceTypes } from '../../../models/conductor.model';
import parseServiceType from '../../composeFile/parseServiceType/parseServiceType';
import { THIRD_PARTY_SERVICES } from '../../fetchAllServicesInCompose/fetchAllServicesInCompose.model';
import inferServiceType from '../../inferServiceType/inferServiceType';
import { KubernetesLabels } from '../kubernetes.model';

// Helm sets it to the release name on everything a chart installs
export const RELEASE_LABEL = 'app.kubernetes.io/instance';

const TYPE_LABEL = `${LabelPrefix.CONDUCTOR}.type`;

const GLUESYNC_PREFIX = 'gluesync-';

/**
 * The Docker-style id of a workload, the one every caller of the Conductor
 * knows: the chart names a workload `<release>-<id>`, so the release
 * (`app.kubernetes.io/instance`) is taken off the front
 * (`prod-gluesync-core-hub` -> `gluesync-core-hub`). The third-party services,
 * `gluesync-grafana` and `gluesync-prometheus` in the chart, get the id they
 * have in a Docker kit (`grafana`, `prometheus`). A workload without the
 * release label, or whose name does not start with it, keeps its name.
 */
export const toServiceId = (
  name: string,
  labels: KubernetesLabels = {},
): string => {
  const release = labels[RELEASE_LABEL]?.trim();
  const prefix = release ? `${release}-` : '';
  const withoutRelease =
    prefix && name.startsWith(prefix) && name.length > prefix.length
      ? name.slice(prefix.length)
      : name;
  const withoutGluesync = withoutRelease.startsWith(GLUESYNC_PREFIX)
    ? withoutRelease.slice(GLUESYNC_PREFIX.length)
    : withoutRelease;

  return THIRD_PARTY_SERVICES.has(withoutGluesync)
    ? withoutGluesync
    : withoutRelease;
};

/**
 * The Conductor type of a workload, by the rules of a Docker kit: a
 * third-party id first (as `inferServiceType` does), then the
 * `com.molo17.conductor.type` label of the workload, then the image looked up
 * in agents.json.
 */
export const kubernetesServiceType = (
  id: string,
  image: string,
  labels: KubernetesLabels = {},
): ConductorServiceTypes | 'unknown' =>
  (THIRD_PARTY_SERVICES.has(id) ? 'third-party' : null) ||
  parseServiceType(labels[TYPE_LABEL]) ||
  inferServiceType(id, image) ||
  'unknown';
