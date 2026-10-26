import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getLogger } from '../../../utils/logger';
import listStackServices from '../listStackServices/listStackServices';
import serviceLogs from '../serviceLogs/serviceLogs';
import { SwarmService } from '../swarm.model';
import { ExportSwarmServiceLogs } from './exportSwarmServiceLogs.model';

const SEPARATOR =
  '================================================================================';

const header = (
  service: SwarmService,
  sinceHours: number,
  tailLines?: number,
): string =>
  [
    `Service Logs for: ${service.name}`,
    `Service ID: ${service.serviceId}`,
    `Image: ${service.image || 'unknown'}`,
    `Collected on: ${new Date().toISOString()}`,
    `Since: last ${sinceHours} hours`,
    `Tail lines: ${tailLines === undefined ? 'all' : String(tailLines)}`,
    '',
    SEPARATOR,
    '',
  ].join('\n');

/**
 * `docker logs` of a node only sees its own containers: in a swarm the logs
 * of a service come from `docker service logs`, from every task on every node.
 * A service whose logs cannot be read still gets its file, with the reason,
 * so the support team sees what is missing.
 */
const exportSwarmServiceLogs: ExportSwarmServiceLogs = async (
  docker,
  namespace,
  { outputDirectory, sinceHours, tailLines },
) => {
  await mkdir(outputDirectory, { recursive: true });

  const services = await listStackServices(docker, namespace);
  const tail =
    typeof tailLines === 'number' && Number.isFinite(tailLines) && tailLines > 0
      ? tailLines
      : undefined;

  return Promise.all(
    services.map(async service => {
      const safeName = service.name.replace(/[\\/:*?"<>|]/g, '_');
      const filePath = join(outputDirectory, `service-${safeName}.log`);

      const body = await serviceLogs(service.name, sinceHours, tail).catch(
        (error: unknown) => {
          getLogger().warn(
            { service: service.name, error },
            'docker service logs failed',
          );

          return `\n[collect-logs] docker service logs failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`;
        },
      );

      await writeFile(
        filePath,
        `${header(service, sinceHours, tail)}${body}`,
        'utf8',
      );

      return filePath;
    }),
  );
};

export default exportSwarmServiceLogs;
