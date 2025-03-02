import { ComposeFile, ComposeService } from '../../models/composeFile.model';

import extractKeyValue from '../extractKeyValue/extractKeyValue';

const mergeArrays = (
  ...arrays: ReadonlyArray<string>[]
): ReadonlyArray<string> | undefined => {
  const newArray = [...new Set(arrays.flat())];
  return newArray.length > 0 ? newArray : undefined;
};

const mergeTwoEnvironments = (
  environment1?: ComposeService['environment'],
  environment2?: ComposeService['environment'],
): Required<ComposeService['environment']> =>
  Object.entries({
    ...extractKeyValue(environment1),
    ...extractKeyValue(environment2),
  }).map(([key, value]) => `${key}=${value}`);

const mergeTwoServices = (
  service1?: ComposeService,
  service2?: ComposeService,
): ComposeService => {
  console.log('service1', service1);
  console.log('service2', service2);
  return {
    ...service1,
    ...service2,
    environment: mergeTwoEnvironments(
      service1?.environment,
      service2?.environment,
    ),
    ports: mergeArrays(service1?.ports || [], service2?.ports || []),
    volumes: mergeArrays(service1?.volumes || [], service2?.volumes || []),
  };
};

const mergeServices = (servicesList: Record<string, any>[]) =>
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
