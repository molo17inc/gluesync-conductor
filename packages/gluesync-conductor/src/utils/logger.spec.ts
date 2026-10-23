import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { serializeError } from './logger';

describe('serializeError', () => {
  it('keeps the message of an Error (it used to be logged as {})', () => {
    const out = serializeError(
      Object.assign(new Error('boom'), { code: 'ECONNRESET' }),
    ) as Record<string, unknown>;
    assert.equal(out.message, 'boom');
    assert.equal(out.code, 'ECONNRESET');
    assert.equal(out.type, 'Error');
    assert.equal(typeof out.stack, 'string');
  });

  it('keeps status and url of an HTTP error without its request config', () => {
    const error = Object.assign(
      new Error('Request failed with status code 404'),
      {
        response: { status: 404 },
        config: {
          url: 'https://api.example/x',
          method: 'get',
          headers: { Authorization: 'Bearer secret' },
        },
      },
    );
    const out = serializeError(error) as Record<string, unknown>;
    assert.equal(out.status, 404);
    assert.equal(out.url, 'https://api.example/x');
    assert.equal(JSON.stringify(out).includes('secret'), false);
  });

  it('passes non-errors through', () => {
    assert.deepEqual(serializeError({ exitCode: 1 }), { exitCode: 1 });
  });
});
