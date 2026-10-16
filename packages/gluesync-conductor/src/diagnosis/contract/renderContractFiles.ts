import buildDiagnosisFixtures from './diagnosisFixtures';
import buildDiagnosisJsonSchema from './diagnosisSchema';

const toJsonFile = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

/** The files other repos vendor, keyed by file name. Generated, never hand-edited. */
const renderContractFiles = (): Readonly<Record<string, string>> => ({
  'diagnosis.v1.schema.json': toJsonFile(buildDiagnosisJsonSchema()),
  'diagnosis.v1.fixtures.json': toJsonFile(buildDiagnosisFixtures()),
});

export default renderContractFiles;
