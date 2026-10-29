import type Docker from 'dockerode';

import { getLogger } from '../../../utils/logger';
import getService from '../getService/getService';
import { UPDATE_CONFIG_LABEL } from '../swarm.model';
import updateServiceSpec from '../updateServiceSpec/updateServiceSpec';
import waitForServiceConverged from '../waitForServiceConverged/waitForServiceConverged';
import {
  RestoreSelfUpdateConfig,
  RestoreUpdateConfig,
} from './restoreUpdateConfig.model';

// The stashed JSON: an object, or `null` for a service that had none. Anything
// else is not ours to write back, and the current settings stay.
const parseStashed = (
  stashed: string,
): Docker.ServiceSpec['UpdateConfig'] | null | undefined => {
  try {
    const value: unknown = JSON.parse(stashed);

    return value === null || typeof value === 'object'
      ? (value as Docker.ServiceSpec['UpdateConfig'] | null)
      : undefined;
  } catch {
    return undefined;
  }
};

const withoutStashLabel = (
  labels: Readonly<Record<string, string>> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(labels ?? {}).filter(([key]) => key !== UPDATE_CONFIG_LABEL),
  );

const withUpdateConfig = (
  spec: Readonly<Docker.ServiceSpec>,
  updateConfig:
    | Readonly<NonNullable<Docker.ServiceSpec['UpdateConfig']>>
    | null
    | undefined,
): Docker.ServiceSpec => {
  if (updateConfig === undefined) {
    return { ...spec };
  }

  if (updateConfig === null) {
    return Object.fromEntries(
      Object.entries(spec).filter(([key]) => key !== 'UpdateConfig'),
    ) as Docker.ServiceSpec;
  }

  return { ...spec, UpdateConfig: updateConfig };
};

/**
 * Puts back the UpdateConfig that updateServiceImage stashed: the rollback
 * settings are for Conductor's own update, the stack file (and the next
 * `docker stack deploy`) has the service's. Neither the labels nor the
 * UpdateConfig are part of the task template, so no task is replaced.
 */
const restoreUpdateConfig: RestoreUpdateConfig = async (docker, fullName) => {
  const { labels } = await getService(docker, fullName);
  const stashed = labels[UPDATE_CONFIG_LABEL];

  if (stashed === undefined) {
    return 'nothing-stashed';
  }

  await updateServiceSpec(docker, fullName, spec =>
    withUpdateConfig(
      { ...spec, Labels: withoutStashLabel(spec.Labels) },
      parseStashed(spec.Labels?.[UPDATE_CONFIG_LABEL] ?? stashed),
    ),
  );

  getLogger().info(
    { service: fullName },
    '[swarm] update settings of the service restored',
  );

  return 'restored';
};

/**
 * The Conductor that updated itself is gone before its update ends, so the one
 * that starts restores its own service's UpdateConfig, once Swarm calls the
 * update good. Never throws: it runs in the background of the startup.
 */
export const restoreSelfUpdateConfig: RestoreSelfUpdateConfig = async (
  docker,
  fullName,
  options,
) => {
  const logger = getLogger();

  try {
    const { labels } = await getService(docker, fullName);

    if (labels[UPDATE_CONFIG_LABEL] === undefined) {
      return 'nothing-stashed';
    }

    const converged = await waitForServiceConverged(docker, fullName, options);

    if (!converged.ok) {
      logger.warn(
        { service: fullName, reason: converged.reason },
        '[swarm] the Conductor update did not converge: its update settings are left to the rollback',
      );

      return 'not-converged';
    }

    return await restoreUpdateConfig(docker, fullName);
  } catch (error) {
    logger.warn(
      { error, service: fullName },
      '[swarm] could not restore the update settings of the Conductor service',
    );

    return 'failed';
  }
};

export default restoreUpdateConfig;
