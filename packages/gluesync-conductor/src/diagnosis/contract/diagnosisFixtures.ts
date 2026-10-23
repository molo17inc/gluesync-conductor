import buildDiagnosis from '../buildDiagnosis';
import { DIAGNOSIS_CODES, Diagnosis } from '../diagnosis.model';
import { DIAGNOSIS_CATALOG } from '../diagnosisCatalog';

const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

/**
 * One example payload per code, with fixed values so the committed copy is
 * stable. Consumers use them as test data (e.g. "every code has a translation").
 */
const buildDiagnosisFixtures = (): Readonly<Record<string, Diagnosis>> =>
  Object.fromEntries(
    DIAGNOSIS_CODES.map(code => [
      code,
      buildDiagnosis(
        {
          code,
          params: DIAGNOSIS_CATALOG[code].exampleParams,
          checks: [
            { id: 'internet-ip', ok: true, ms: 80, detail: 'HTTP 200' },
            {
              id: 'backoffice',
              ok: code === 'CONNECTIVITY_OK',
              ms: 120,
              detail: 'HTTP 200',
            },
          ],
        },
        { now: () => FIXED_NOW },
      ),
    ]),
  );

export default buildDiagnosisFixtures;
