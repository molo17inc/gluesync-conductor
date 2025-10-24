import {
  ComposeFile,
  composeServiceFieldConfig,
} from '../../../models/composeFile.model';
import { ParseComposeFile } from './parseComposeFile.model';

import extractKeyValue from '../extractKeyValue/extractKeyValue';

const parseComposeFile: ParseComposeFile = composeFile => ({
  ...composeFile,
  services: Object.entries(composeFile.services || {}).reduce<
    ComposeFile['services']
  >(
    (acc, [serviceName, service]) => ({
      ...acc,
      [serviceName]: {
        ...service,
        environment: extractKeyValue(
          composeServiceFieldConfig.environment.separator,
          service.environment,
        ),
        labels: extractKeyValue(
          composeServiceFieldConfig.labels.separator,
          service.labels,
        ),
        volumes: Object.entries(
          extractKeyValue(
            composeServiceFieldConfig.volumes.separator,
            service.volumes,
          ),
        ).map(([key, value]) => ({
          host: key,
          container: String(value),
        })),
        ports: Object.entries(
          extractKeyValue(
            composeServiceFieldConfig.ports.separator,
            service.ports,
          ),
        ).map(([key, value]) => ({
          host: key,
          container: String(value),
        })),
      },
    }),
    {},
  ),
});

export default parseComposeFile;
