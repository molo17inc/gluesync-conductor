import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import fastify from 'fastify';

import {
  DIAGNOSIS_CODES,
  RESOLUTION_CODES,
  Diagnosis,
} from '../diagnosis.model';
import { DIAGNOSIS_CATALOG, RESOLUTION_FALLBACK } from '../diagnosisCatalog';
import buildDiagnosisJsonSchema from './diagnosisSchema';
import renderContractFiles from './renderContractFiles';

const CONTRACTS_DIR = path.resolve(__dirname, '../../../contracts');

const validate = async (payload: unknown): Promise<number> => {
  // Fastify validates request bodies with the same Ajv it uses for routes, which
  // is enough to exercise the schema without adding a dependency.
  const app = fastify({ ajv: { customOptions: { strict: false } } });
  app.post(
    '/validate',
    { schema: { body: buildDiagnosisJsonSchema() } },
    async () => ({
      ok: true,
    }),
  );

  const response = await app.inject({
    method: 'POST',
    url: '/validate',
    payload: payload as object,
  });
  await app.close();

  return response.statusCode;
};

const fixtures = (): Record<string, Diagnosis> =>
  JSON.parse(
    fs.readFileSync(
      path.join(CONTRACTS_DIR, 'diagnosis.v1.fixtures.json'),
      'utf8',
    ),
  );

describe('diagnosis contract files', () => {
  Object.entries(renderContractFiles()).forEach(([name, expected]) => {
    it(`${name} is up to date (run "yarn contract:generate" if this fails)`, () => {
      assert.equal(
        fs.readFileSync(path.join(CONTRACTS_DIR, name), 'utf8'),
        expected,
      );
    });
  });

  it('has one fixture per code', () => {
    assert.deepEqual(
      Object.keys(fixtures()).sort(),
      [...DIAGNOSIS_CODES].sort(),
    );
  });

  it('validates every fixture against the schema', async () => {
    const statuses = await Promise.all(Object.values(fixtures()).map(validate));

    assert.ok(
      statuses.every(status => status === 200),
      statuses.join(','),
    );
  });

  it('rejects payloads that break the contract, so the check above is not vacuous', async () => {
    const valid = fixtures().OTA_SERVICE_DOWN;

    assert.equal(await validate({ ...valid, code: undefined }), 400);
    assert.equal(await validate({ ...valid, owner: 'martian' }), 400);
    assert.equal(await validate({ ...valid, schemaVersion: 2 }), 400);
    assert.equal(
      await validate({ ...valid, resolutionCodes: ['NOT_A_STEP'] }),
      400,
    );
    assert.equal(
      await validate({ ...valid, checks: [{ id: 'nope', ok: true }] }),
      400,
    );
  });

  it('tolerates fields it does not know (additive changes must not break readers)', async () => {
    assert.equal(
      await validate({
        ...fixtures().OTA_SERVICE_DOWN,
        somethingNew: { a: 1 },
      }),
      200,
    );
  });
});

describe('diagnosis catalog', () => {
  DIAGNOSIS_CODES.forEach(code => {
    const entry = DIAGNOSIS_CATALOG[code];

    it(`${code}: has complete English fallback text`, () => {
      assert.ok(entry.title.length > 0);
      assert.ok(entry.summary(entry.exampleParams).length > 0);
      assert.ok(
        entry.resolutionCodes.every(step => RESOLUTION_CODES.includes(step)),
      );
    });

    it(`${code}: its example params cover exactly the keys it declares`, () => {
      assert.ok(
        Object.keys(entry.exampleParams).every(key =>
          entry.paramKeys.includes(key),
        ),
        'exampleParams has a key not listed in paramKeys',
      );
    });

    it(`${code}: summary fills in its params without placeholders left over`, () => {
      const summary = entry.summary(entry.exampleParams);

      assert.ok(!summary.includes('undefined'), summary);
      assert.ok(!summary.includes('?'), summary);
    });
  });

  it('has fallback text for every resolution code', () => {
    RESOLUTION_CODES.forEach(step => {
      assert.ok(RESOLUTION_FALLBACK[step].length > 0, step);
    });
  });

  // Customers read these texts and copy them to their network team. An AWS
  // address belongs to MOLO17's infrastructure, may change, and is not something
  // they need to allow through a firewall.
  it('never shows an internal AWS address to customers', () => {
    const customerFacing = DIAGNOSIS_CODES.map(code => {
      const entry = DIAGNOSIS_CATALOG[code];

      return JSON.stringify([
        entry.title,
        entry.summary(entry.exampleParams),
        entry.exampleParams,
      ]);
    }).concat(
      fs.readFileSync(
        path.join(CONTRACTS_DIR, 'diagnosis.v1.fixtures.json'),
        'utf8',
      ),
    );

    customerFacing.forEach(text => {
      assert.ok(!/amazonaws\.com/i.test(text), text.slice(0, 120));
    });
  });

  it('only uses HTTP statuses that mean "this request failed" (except the OK code)', () => {
    DIAGNOSIS_CODES.filter(code => code !== 'CONNECTIVITY_OK').forEach(code => {
      assert.ok(
        [502, 503].includes(DIAGNOSIS_CATALOG[code].httpStatus),
        `${code} -> ${DIAGNOSIS_CATALOG[code].httpStatus}`,
      );
    });
  });

  it('keeps 503 for "MOLO17 is down" and Conductor-local conditions only', () => {
    const with503 = DIAGNOSIS_CODES.filter(
      code => DIAGNOSIS_CATALOG[code].httpStatus === 503,
    ).sort();

    assert.deepEqual(with503, [
      'CONDUCTOR_UPDATING',
      'COREHUB_UNAVAILABLE',
      'DOCKER_NOT_READY',
      'OTA_SERVICE_DOWN',
    ]);
  });
});
