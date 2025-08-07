import mergeComposeKeyValueField from '../mergeKeyValueStrings/mergeKeyValueStrings';

import {
  RawComposeFile,
  RawComposeService,
  composeServiceFieldConfig,
  ComposeServiceFieldName,
} from '../../../models/composeFile.model';
import { MergeTwoServices } from './mergeComposeFiles.model';

const mergeTwoServices: MergeTwoServices = (service1, service2) => ({
  ...service1,
  ...service2,
  ...(
    Object.keys(
      composeServiceFieldConfig,
    ) as ReadonlyArray<ComposeServiceFieldName>
  ).reduce<
    Partial<Record<ComposeServiceFieldName, ReadonlyArray<string> | undefined>>
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
});

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
