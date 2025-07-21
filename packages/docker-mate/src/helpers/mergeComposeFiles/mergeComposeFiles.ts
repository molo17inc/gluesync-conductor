import { ComposeFile, ComposeService } from '../../models/composeFile.model';

import mergeComposeKeyValueField from '../composeFile/mergeKeyValueStrings/mergeKeyValueStrings';
import { MergeTwoServices } from './mergeComposeFiles.model';

// const mergeTwoServices = (
//   service1?: ComposeService,
//   service2?: ComposeService,
// ): ComposeService => ({
//   ...service1,
//   ...service2,
//   ...(
//     Object.keys(
//       composeServiceFieldConfig,
//     ) as ReadonlyArray<ComposeServiceFieldName>
//   ).reduce(
//     (acc, field) => ({
//       ...acc,
//       [field]: mergeComposeKeyValueField(
//         field,
//         service1?.[field],
//         service2?.[field],
//       ),
//     }),
//     {} as Partial<
//       Record<ComposeServiceFieldName, ReadonlyArray<string> | undefined>
//     >,
//   ),
// });

const mergeTwoServices: MergeTwoServices = (service1, service2) => ({
  ...service1,
  ...service2,
  environment: mergeComposeKeyValueField(
    'environment',
    service1?.environment,
    service2?.environment,
  ),
  labels: mergeComposeKeyValueField(
    'labels',
    service1?.labels,
    service2?.labels,
  ),
  ports: mergeComposeKeyValueField(
    'ports',
    service1?.ports || [],
    service2?.ports || [],
  ),
  volumes: mergeComposeKeyValueField(
    'volumes',
    service1?.volumes || [],
    service2?.volumes || [],
  ),
});

export const mergeServices = (servicesList: Record<string, ComposeService>[]) =>
  servicesList.reduce(
    (merged, services) =>
      Object.keys({ ...merged, ...services }).reduce(
        (acc, serviceName) => ({
          ...acc,
          [serviceName]: mergeTwoServices(
            merged[serviceName],
            services[serviceName],
          ),
        }),
        {},
      ),
    {},
  );

const mergeComposeFiles = (
  composeFiles: ReadonlyArray<ComposeFile>,
): ComposeFile =>
  composeFiles.reduce(
    (merged, current) => ({
      ...merged,
      ...current,
      services: mergeServices([merged.services || {}, current.services || {}]),
    }),
    {},
  );

export default mergeComposeFiles;
