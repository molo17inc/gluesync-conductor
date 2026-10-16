import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fastify from 'fastify';

import normalizeUpstreamErrorBody from './normalizeUpstreamErrorBody';

const FALLBACK = 'Unable to retrieve service version';

describe('normalizeUpstreamErrorBody', () => {
  it('does not spread an HTML string into one key per character', () => {
    const body = normalizeUpstreamErrorBody(
      '<html><body>Blocked by corporate policy</body></html>',
      FALLBACK,
    );

    assert.deepEqual(Object.keys(body).sort(), ['details', 'error']);
    assert.equal(body.error, FALLBACK);
    assert.match(String(body.details), /Blocked by corporate policy/);
  });

  it('maps a JSON { message } body onto error/details', () => {
    assert.deepEqual(
      normalizeUpstreamErrorBody({ message: 'Not Found' }, FALLBACK),
      { error: FALLBACK, details: 'Not Found' },
    );
  });

  it('keeps an upstream error string and any extra fields', () => {
    assert.deepEqual(
      normalizeUpstreamErrorBody({ error: 'Nope', requestId: 'abc' }, FALLBACK),
      { error: 'Nope', requestId: 'abc' },
    );
  });

  it('copes with empty and non-string bodies', () => {
    assert.deepEqual(normalizeUpstreamErrorBody(undefined, FALLBACK), {
      error: FALLBACK,
    });
    assert.deepEqual(normalizeUpstreamErrorBody('   ', FALLBACK), {
      error: FALLBACK,
    });
    assert.deepEqual(normalizeUpstreamErrorBody(['x'], FALLBACK), {
      error: FALLBACK,
    });
  });

  it('truncates a very long body and masks credentials in it', () => {
    const body = normalizeUpstreamErrorBody(
      `http://alice:S3CR3T@proxy.corp ${'x'.repeat(2000)}`,
      FALLBACK,
    );

    assert.ok(String(body.details).length <= 501);
    assert.ok(!String(body.details).includes('S3CR3T'));
  });

  // Regression: a JSON error body without an `error` field made Fastify answer
  // 500 FST_ERR_FAILED_ERROR_SERIALIZATION against the route's 404 schema.
  it('produces a body the route response schema can serialise', async () => {
    const app = fastify();
    // Copied from the 404 schema of GET /services/:id/version in routes/services.ts.
    const schema = {
      response: {
        404: {
          type: 'object',
          properties: {
            success: { type: 'boolean', const: false },
            error: { type: 'string' },
          },
          required: ['success', 'error'],
          additionalProperties: false,
        },
      },
    };

    app.get('/upstream-404', { schema }, async (_req, reply) =>
      reply.code(404).send({
        success: false,
        ...normalizeUpstreamErrorBody({ message: 'Not Found' }, FALLBACK),
      }),
    );

    const response = await app.inject({ method: 'GET', url: '/upstream-404' });
    await app.close();

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, FALLBACK);
  });
});
