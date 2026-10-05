import {
  DIAGNOSIS_SCHEMA_VERSION,
  Diagnosis,
  DiagnosisCheck,
  DiagnosisConfidence,
  DiagnosisCode,
  DiagnosisParams,
} from './diagnosis.model';
import { DIAGNOSIS_CATALOG, RESOLUTION_FALLBACK } from './diagnosisCatalog';

export type BuildDiagnosisInput = Readonly<{
  code: DiagnosisCode;
  confidence?: DiagnosisConfidence;
  params?: DiagnosisParams;
  checks?: ReadonlyArray<DiagnosisCheck>;
}>;

export type BuildDiagnosisDeps = Readonly<{
  now?: () => Date;
}>;

/** Assembles the contract object from a code: owner, steps and English fallback come from the catalog. */
const buildDiagnosis = (
  { code, confidence = 'high', params = {}, checks = [] }: BuildDiagnosisInput,
  { now = () => new Date() }: BuildDiagnosisDeps = {},
): Diagnosis => {
  const entry = DIAGNOSIS_CATALOG[code];

  return {
    schemaVersion: DIAGNOSIS_SCHEMA_VERSION,
    code,
    owner: entry.owner,
    confidence,
    params,
    resolutionCodes: entry.resolutionCodes,
    fallback: {
      title: entry.title,
      summary: entry.summary(params),
      steps: entry.resolutionCodes.map(step => RESOLUTION_FALLBACK[step]),
    },
    checks,
    source: { service: 'gluesync-conductor' },
    at: now().toISOString(),
  };
};

export default buildDiagnosis;
