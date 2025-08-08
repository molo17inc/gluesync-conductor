import mergeComposeKeyValueField from '../mergeKeyValueStrings/mergeKeyValueStrings';

import {
  RawComposeFile,
  RawComposeService,
  composeServiceFieldConfig,
  ComposeServiceFieldName,
} from '../../../models/composeFile.model';
import { MergeTwoServices } from './mergeComposeFiles.model';
import cleanObject from '../../cleanObject/cleanOjbect';

const pickResource = <T extends string | number | null | undefined>(
  newValue: T,
  oldValue: T,
): T =>
  newValue === null || String(newValue).trim() === ''
    ? (null as T)
    : newValue || oldValue;

const mergeTwoServices: MergeTwoServices = (service1, service2) => {
  console.log(
    `Deploy here!: ${JSON.stringify(service1?.deploy)} ${JSON.stringify(service2?.deploy)}`,
  );

  const limCpus = pickResource(
    service2?.deploy?.resources?.limits?.cpus,
    service1?.deploy?.resources?.limits?.cpus,
  );
  const limMemory = pickResource(
    service2?.deploy?.resources?.limits?.memory,
    service1?.deploy?.resources?.limits?.memory,
  );
  const resvCpus = pickResource(
    service2?.deploy?.resources?.reservations?.cpus,
    service1?.deploy?.resources?.reservations?.cpus,
  );
  const resvMemory = pickResource(
    service2?.deploy?.resources?.reservations?.memory,
    service1?.deploy?.resources?.reservations?.memory,
  );

  return {
    ...service1,
    ...service2,
    deploy: {
      resources: {
        reservations: {
          ...(resvCpus && { cpus: resvCpus }),
          ...(resvMemory && { memory: resvMemory }),
        },
        limits: {
          ...(limCpus && { cpus: limCpus }),
          ...(limMemory && { memory: limMemory }),
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
  servicesList: ReadonlyArray<Readonly<Record<string, RawComposeService>>>,
): Record<string, RawComposeService> =>
  servicesList.reduce<Record<string, RawComposeService>>(
    (merged, services) =>
      Object.entries(services).reduce<Record<string, RawComposeService>>(
        (acc, [serviceName, currentCompose]) => {
          const existingCompose = acc[serviceName];

          return {
            ...acc,
            [serviceName]:
              existingCompose && currentCompose
                ? (mergeTwoServices(
                    existingCompose,
                    currentCompose,
                  ) as RawComposeService)
                : (existingCompose ?? currentCompose),
          };
        },
        merged,
      ),
    {},
  );

const mergeComposeFiles = (
  composeFiles: ReadonlyArray<RawComposeFile>,
): RawComposeFile =>
  cleanObject(
    composeFiles.reduce(
      (merged, current) => ({
        ...merged,
        ...current,
        services: mergeServices([
          merged.services || {},
          current.services || {},
        ]),
      }),
      {},
    ),
  );

export default mergeComposeFiles;
