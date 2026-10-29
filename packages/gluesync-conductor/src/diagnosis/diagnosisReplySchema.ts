/**
 * Response-schema pieces for routes that can fail with a diagnosis. Fastify
 * serializes replies by schema, and a property a schema does not list is
 * dropped, so `diagnosis` has to be named on every error status that carries it.
 */
export const DIAGNOSIS_REPLY_PROPERTY = {
  type: 'object',
  description:
    'Diagnosis contract v1 (see contracts/diagnosis.v1.schema.json): why the request failed and what to do.',
  additionalProperties: true,
};

/** 507: the disk that holds Conductor's files has no room for the write, and nothing was changed. */
export const DISK_FULL_REPLY_SCHEMA = {
  description:
    'There is not enough free disk space on the host. Nothing was changed. `diagnosis.code` is DISK_FULL.',
  type: 'object',
  properties: {
    success: { type: 'boolean', const: false },
    error: { type: 'string' },
    details: { type: 'string', nullable: true },
    diagnosis: DIAGNOSIS_REPLY_PROPERTY,
  },
  required: ['success', 'error'],
  additionalProperties: true,
};
