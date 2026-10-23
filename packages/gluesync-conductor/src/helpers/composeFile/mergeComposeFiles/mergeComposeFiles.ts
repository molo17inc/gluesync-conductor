import mergeComposeKeyValueField from '../mergeKeyValueStrings/mergeKeyValueStrings';

import {
  ComposeServiceDeploy,
  RawComposeFile,
  RawComposeService,
  composeServiceFieldConfig,
  ComposeServiceFieldName,
} from '../../../models/composeFile.model';
import { KeyValueEntry } from '../extractKeyValue/extractKeyValue.model';
import { MergeTwoServices } from './mergeComposeFiles.model';
import cleanObject from '../../cleanObject/cleanOjbect';

const pickResource = <T extends string | number | null | undefined>(
  newValue: T,
  oldValue: T,
): T =>
  newValue === null || String(newValue).trim() === ''
    ? (null as T)
    : newValue || oldValue;

// Every deploy key other than resources (replicas, placement, update_config...)
// passes through, the later service winning key by key. Resources are merged
// separately below so that clearing them stays possible.
const withoutResources = (
  deploy: RawComposeService['deploy'],
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(deploy ?? {}).filter(([key]) => key !== 'resources'),
  );

const mergeTwoServices: MergeTwoServices = (service1, service2) => {
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

  const resources = {
    ...((resvCpus || resvMemory) && {
      reservations: {
        ...(resvCpus && { cpus: resvCpus }),
        ...(resvMemory && { memory: resvMemory }),
      },
    }),
    ...((limCpus || limMemory) && {
      limits: {
        ...(limCpus && { cpus: limCpus }),
        ...(limMemory && { memory: limMemory }),
      },
    }),
  };

  const deploy = {
    ...withoutResources(service1?.deploy),
    ...withoutResources(service2?.deploy),
    ...(Object.keys(resources).length > 0 && { resources }),
  } as ComposeServiceDeploy;

  return {
    ...service1,
    ...service2,
    // Always set when a service had one, so that a service2 deploy that
    // lost its resources does not come back through the spread above
    ...((service1?.deploy || service2?.deploy) && {
      deploy: Object.keys(deploy).length > 0 ? deploy : undefined,
    }),
    ...(
      Object.keys(
        composeServiceFieldConfig,
      ) as ReadonlyArray<ComposeServiceFieldName>
    ).reduce<
      Partial<
        Record<
          ComposeServiceFieldName,
          ReadonlyArray<KeyValueEntry> | undefined
        >
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
