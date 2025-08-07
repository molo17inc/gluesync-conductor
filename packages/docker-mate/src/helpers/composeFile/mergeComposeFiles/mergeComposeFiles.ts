import mergeComposeKeyValueField from '../mergeKeyValueStrings/mergeKeyValueStrings';

import {
  RawComposeFile,
  RawComposeService,
  composeServiceFieldConfig,
  ComposeServiceFieldName,
} from '../../../models/composeFile.model';
import { MergeTwoServices } from './mergeComposeFiles.model';

const mergeTwoServices: MergeTwoServices = (service1, service2) => {
  console.log(
    `Deploy here!: ${JSON.stringify(service1?.deploy)} ${JSON.stringify(service2?.deploy)}`,
  );
  return {
    ...service1,
    ...service2,
    deploy: {
      resources: {
        reservations: {
          cpus:
            service2?.deploy?.resources?.reservations?.cpus ||
            service1?.deploy?.resources?.reservations?.cpus,
          memory:
            service2?.deploy?.resources?.reservations?.memory ||
            service1?.deploy?.resources?.reservations?.memory,
        },
        limits: {
          cpus:
            service2?.deploy?.resources?.limits?.cpus ||
            service1?.deploy?.resources?.limits?.cpus,
          memory:
            service2?.deploy?.resources?.limits?.memory ||
            service1?.deploy?.resources?.limits?.memory,
        },
      },
    },
    ...(
      Object.keys(
        composeServiceFieldConfig,
      ) as ReadonlyArray<ComposeServiceFieldName>
    ).reduce<
      Partial<
        Record<ComposeServiceFieldName, ReadonlyArray<string> | undefined>
      >
    >(
      (acc, field) => ({
        ...acc,
        [field]: mergeComposeKeyValueField(
          field,
          service1?.[field],
          service2?.[field],
        ),
      }),
      {},
    ),
  };
};

export const mergeServices = (
  servicesList: Readonly<Record<string, RawComposeService>[]>,
) =>
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
  composeFiles: ReadonlyArray<RawComposeFile>,
): RawComposeFile =>
  composeFiles.reduce(
    (merged, current) => ({
      ...merged,
      ...current,
      services: mergeServices([merged.services || {}, current.services || {}]),
    }),
    {},
  );

export default mergeComposeFiles;
