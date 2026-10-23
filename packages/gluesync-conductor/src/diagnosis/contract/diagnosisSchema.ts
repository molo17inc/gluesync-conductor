import {
  CHECK_IDS,
  DIAGNOSIS_CODES,
  DIAGNOSIS_CONFIDENCES,
  DIAGNOSIS_OWNERS,
  DIAGNOSIS_SCHEMA_VERSION,
  RESOLUTION_CODES,
} from '../diagnosis.model';
import { DIAGNOSIS_CATALOG } from '../diagnosisCatalog';

/**
 * JSON Schema (draft-07) for the diagnosis contract, generated from the same
 * constants the code uses so the two cannot drift. The committed copy in
 * `contracts/` is what other repos vendor; `scripts/generateDiagnosisContract.ts`
 * rewrites it and a test fails when it is out of date.
 */
const buildDiagnosisJsonSchema = () => ({
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://schemas.molo17.com/gluesync/diagnosis.v1.json',
  title: 'Gluesync Diagnosis v1',
  description:
    'Structured explanation of why a request failed or what a connectivity check found. Consumers must ignore unknown fields and fall back to `fallback` for unknown codes.',
  type: 'object',
  required: [
    'schemaVersion',
    'code',
    'owner',
    'confidence',
    'params',
    'resolutionCodes',
    'fallback',
    'checks',
    'source',
    'at',
  ],
  additionalProperties: true,
  properties: {
    schemaVersion: { const: DIAGNOSIS_SCHEMA_VERSION },
    code: { type: 'string', enum: [...DIAGNOSIS_CODES] },
    owner: { type: 'string', enum: [...DIAGNOSIS_OWNERS] },
    confidence: { type: 'string', enum: [...DIAGNOSIS_CONFIDENCES] },
    params: {
      type: 'object',
      additionalProperties: {
        anyOf: [
          { type: 'string' },
          { type: 'number' },
          { type: 'boolean' },
          { type: 'array', items: { type: 'string' } },
        ],
      },
    },
    resolutionCodes: {
      type: 'array',
      items: { type: 'string', enum: [...RESOLUTION_CODES] },
    },
    fallback: {
      type: 'object',
      required: ['title', 'summary', 'steps'],
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        steps: { type: 'array', items: { type: 'string' } },
      },
    },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'ok'],
        properties: {
          id: { type: 'string', enum: [...CHECK_IDS] },
          ok: { type: 'boolean' },
          ms: { type: 'number' },
          detail: { type: 'string' },
        },
      },
    },
    source: {
      type: 'object',
      required: ['service'],
      properties: {
        service: { type: 'string' },
        version: { type: 'string' },
      },
    },
    at: { type: 'string' },
  },
  // Translators need to know what each code carries.
  'x-gluesync-codes': Object.fromEntries(
    DIAGNOSIS_CODES.map(code => {
      const entry = DIAGNOSIS_CATALOG[code];

      return [
        code,
        {
          owner: entry.owner,
          resolutionCodes: [...entry.resolutionCodes],
          params: [...entry.paramKeys],
        },
      ];
    }),
  ),
});

export default buildDiagnosisJsonSchema;
