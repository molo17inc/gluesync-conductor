import type Docker from 'dockerode';

import { STACK_NAMESPACE_LABEL } from '../swarm.model';
import stripImageDigest from '../stripImageDigest/stripImageDigest';
import { MapService } from './mapService.model';

export const containerSpecOf = (
  spec?: Readonly<Docker.ServiceSpec>,
): Docker.ContainerSpec | undefined =>
  (spec?.TaskTemplate as Docker.ContainerTaskSpec | undefined)?.ContainerSpec;

const mapService: MapService = service => {
  const spec = service.Spec ?? {};
  const name = spec.Name ?? '';
  const namespace = spec.Labels?.[STACK_NAMESPACE_LABEL];
  const prefix = namespace ? `${namespace}_` : undefined;
  const container = containerSpecOf(spec);

  return {
    id: prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name,
    serviceId: service.ID,
    name,
    image: stripImageDigest(container?.Image ?? ''),
    labels: spec.Labels ?? {},
    containerLabels: container?.Labels ?? {},
    replicas: spec.Mode?.Replicated?.Replicas,
    updateState: service.UpdateStatus?.State,
    updateMessage: service.UpdateStatus?.Message,
    version: service.Version?.Index ?? 0,
    spec,
    previousSpec: service.PreviousSpec,
  };
};

export default mapService;
