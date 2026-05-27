export const errorResponseSchema = {
  $id: 'ErrorResponse',
  type: 'object',
  required: ['success', 'error'],
  properties: {
    success: {
      type: 'boolean',
      const: false,
    },
    error: {
      type: 'string',
    },
    details: {
      type: 'string',
    },
  },
};
