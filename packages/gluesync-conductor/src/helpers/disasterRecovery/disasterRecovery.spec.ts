/* eslint-disable functional/immutable-data, functional/no-let, functional/prefer-immutable-types, no-template-curly-in-string -- the spec points PROJECT_CWD at a temporary project and writes env files into it; `${VAR}` is compose syntax, not a template */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  DR_UPDATE_BLOCKED_REASON,
  DR_UPDATE_REFUSED_DETAILS,
  DR_UPDATE_REFUSED_ERROR,
  getDisasterRecoveryUpdateBlock,
  getDisasterRecoveryUpdateRefusal,
  isDisasterRecoveryEnabled,
} from './disasterRecovery';
import type {
  DisasterRecoveryCompose,
  DisasterRecoveryService,
} from './disasterRecovery.model';

const CORE_HUB = 'gluesync-core-hub';
const CHRONOS = 'gluesync-chronos';

const ENV_KEYS = ['PROJECT_CWD', 'CORE_HUB_NAME', 'CHRONOS_NAME'] as const;
const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

let projectDir = '';

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'conductor-dr-'));
  process.env.PROJECT_CWD = projectDir;
  delete process.env.CORE_HUB_NAME;
  delete process.env.CHRONOS_NAME;
});

afterEach(async () => {
  ENV_KEYS.forEach(key => {
    const value = saved[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
  await rm(projectDir, { recursive: true, force: true });
});

const compose = (
  coreHub: DisasterRecoveryService,
): DisasterRecoveryCompose => ({
  services: {
    [CORE_HUB]: coreHub,
    [CHRONOS]: {},
    'gluesync-mssql-ct': {},
  },
});

const dr = (coreHub: DisasterRecoveryService) =>
  isDisasterRecoveryEnabled(compose(coreHub));

describe('isDisasterRecoveryEnabled', () => {
  it('is on for GS_DR_ENABLED=true in an environment list', async () => {
    assert.equal(
      await dr({ environment: ['JAVA_OPTS=-Xmx4g', 'GS_DR_ENABLED=true'] }),
      true,
    );
  });

  it('is on for GS_DR_ENABLED in an environment map, as text or boolean', async () => {
    assert.equal(await dr({ environment: { GS_DR_ENABLED: 'true' } }), true);
    assert.equal(await dr({ environment: { GS_DR_ENABLED: true } }), true);
  });

  it('ignores the case and the spaces of the value', async () => {
    assert.equal(await dr({ environment: ['GS_DR_ENABLED= TRUE '] }), true);
    assert.equal(await dr({ environment: { GS_DR_ENABLED: 'True' } }), true);
  });

  it('is off for false, anything else, an empty value or no variable', async () => {
    assert.equal(await dr({ environment: ['GS_DR_ENABLED=false'] }), false);
    assert.equal(await dr({ environment: { GS_DR_ENABLED: false } }), false);
    assert.equal(await dr({ environment: ['GS_DR_ENABLED=1'] }), false);
    assert.equal(await dr({ environment: ['GS_DR_ENABLED='] }), false);
    assert.equal(await dr({ environment: ['OTHER=true'] }), false);
    assert.equal(await dr({ environment: { OTHER: 'true' } }), false);
    assert.equal(await dr({}), false);
  });

  it('is off without a Core Hub service or without services', async () => {
    assert.equal(await isDisasterRecoveryEnabled({}), false);
    assert.equal(
      await isDisasterRecoveryEnabled({
        services: { other: { environment: ['GS_DR_ENABLED=true'] } },
      }),
      false,
    );
  });

  it('only looks at the Core Hub service', async () => {
    assert.equal(
      await isDisasterRecoveryEnabled({
        services: {
          [CORE_HUB]: {},
          'gluesync-mssql-ct': { environment: ['GS_DR_ENABLED=true'] },
        },
      }),
      false,
    );
  });

  it('looks the Core Hub up under CORE_HUB_NAME', async () => {
    process.env.CORE_HUB_NAME = 'hub-b';

    assert.equal(
      await isDisasterRecoveryEnabled({
        services: { 'hub-b': { environment: ['GS_DR_ENABLED=true'] } },
      }),
      true,
    );
  });

  describe('env_file', () => {
    it('reads the variable from an env file, relative to the project', async () => {
      await writeFile(join(projectDir, 'dr.env'), 'A=1\nGS_DR_ENABLED=true\n');

      assert.equal(await dr({ env_file: 'dr.env' }), true);
      assert.equal(await dr({ env_file: ['dr.env'] }), true);
    });

    it('reads object entries and absolute paths, and skips a missing file', async () => {
      const absolute = join(projectDir, 'abs.env');
      await writeFile(absolute, 'GS_DR_ENABLED="true"\n');

      assert.equal(
        await dr({
          env_file: [
            { path: 'missing.env', required: false },
            { path: absolute },
          ],
        }),
        true,
      );
      assert.equal(await dr({ env_file: { path: absolute } }), true);
      assert.equal(await dr({ env_file: ['missing.env'] }), false);
    });

    it('lets a later file win over an earlier one', async () => {
      await writeFile(join(projectDir, 'a.env'), 'GS_DR_ENABLED=true\n');
      await writeFile(join(projectDir, 'b.env'), 'GS_DR_ENABLED=false\n');

      assert.equal(await dr({ env_file: ['a.env', 'b.env'] }), false);
      assert.equal(await dr({ env_file: ['b.env', 'a.env'] }), true);
    });

    it('lets environment win over env_file', async () => {
      await writeFile(join(projectDir, 'dr.env'), 'GS_DR_ENABLED=true\n');

      assert.equal(
        await dr({
          env_file: 'dr.env',
          environment: ['GS_DR_ENABLED=false'],
        }),
        false,
      );
    });
  });

  describe('interpolation from the project .env', () => {
    it('resolves ${VAR} and $VAR', async () => {
      await writeFile(join(projectDir, '.env'), 'DR=true\n');

      assert.equal(await dr({ environment: ['GS_DR_ENABLED=${DR}'] }), true);
      assert.equal(await dr({ environment: { GS_DR_ENABLED: '$DR' } }), true);
    });

    it('uses the default of ${VAR:-default} for an unset or empty variable', async () => {
      assert.equal(
        await dr({ environment: ['GS_DR_ENABLED=${DR:-true}'] }),
        true,
      );

      await writeFile(join(projectDir, '.env'), 'DR=\n');

      assert.equal(
        await dr({ environment: ['GS_DR_ENABLED=${DR:-true}'] }),
        true,
      );
      assert.equal(
        await dr({ environment: ['GS_DR_ENABLED=${DR-true}'] }),
        false,
      );
    });

    it('is off when the variable is not defined, or without a .env', async () => {
      assert.equal(await dr({ environment: ['GS_DR_ENABLED=${DR}'] }), false);

      await writeFile(join(projectDir, '.env'), 'DR=false\n');

      assert.equal(await dr({ environment: ['GS_DR_ENABLED=${DR}'] }), false);
    });

    it('takes a bare GS_DR_ENABLED from the .env', async () => {
      await writeFile(join(projectDir, '.env'), 'GS_DR_ENABLED=true\n');

      assert.equal(await dr({ environment: ['GS_DR_ENABLED'] }), true);
      assert.equal(await dr({ environment: { GS_DR_ENABLED: null } }), true);
    });

    it('keeps $$ as a literal dollar', async () => {
      assert.equal(await dr({ environment: ['GS_DR_ENABLED=$$true'] }), false);
    });
  });
});

describe('getDisasterRecoveryUpdateBlock', () => {
  const onDr = compose({ environment: ['GS_DR_ENABLED=true'] });
  const notDr = compose({ environment: ['GS_DR_ENABLED=false'] });

  it('blocks Core Hub and Chronos with the reason on a DR host', async () => {
    const expected = {
      updateBlocked: true,
      reason: DR_UPDATE_BLOCKED_REASON,
    };

    assert.deepEqual(
      await getDisasterRecoveryUpdateBlock(onDr, CORE_HUB),
      expected,
    );
    assert.deepEqual(
      await getDisasterRecoveryUpdateBlock(onDr, CHRONOS),
      expected,
    );
  });

  it('never blocks the other services', async () => {
    await Promise.all(
      [
        'gluesync-mssql-ct',
        'gluesync-conductor',
        'reverse-proxy',
        'grafana',
      ].map(async id => {
        assert.deepEqual(await getDisasterRecoveryUpdateBlock(onDr, id), {
          updateBlocked: false,
        });
      }),
    );
  });

  it('blocks nothing off a DR host', async () => {
    assert.deepEqual(await getDisasterRecoveryUpdateBlock(notDr, CORE_HUB), {
      updateBlocked: false,
    });
    assert.deepEqual(await getDisasterRecoveryUpdateBlock(notDr, CHRONOS), {
      updateBlocked: false,
    });
  });

  it('follows CHRONOS_NAME', async () => {
    process.env.CHRONOS_NAME = 'chronos-b';

    assert.equal(
      (await getDisasterRecoveryUpdateBlock(onDr, 'chronos-b')).updateBlocked,
      true,
    );
    assert.equal(
      (await getDisasterRecoveryUpdateBlock(onDr, CHRONOS)).updateBlocked,
      false,
    );
  });

  it('gives the reason the docs link, always under /latest/', async () => {
    assert.match(
      DR_UPDATE_BLOCKED_REASON,
      /^Disaster recovery is enabled on this Core Hub: update the sites one at a time/,
    );
    assert.match(
      DR_UPDATE_BLOCKED_REASON,
      /https:\/\/docs\.molo17\.com\/gluesync\/latest\/ \(upgrade a disaster-recovery pair\)\.$/,
    );
    assert.equal(
      DR_UPDATE_REFUSED_ERROR,
      'Disaster recovery is enabled on this Core Hub',
    );
    assert.match(DR_UPDATE_REFUSED_DETAILS, /^Update the sites one at a time/);
  });
});

describe('getDisasterRecoveryUpdateRefusal', () => {
  const onDr = compose({ environment: ['GS_DR_ENABLED=true'] });
  const notDr = compose({});

  it('refuses Core Hub, Chronos and "update all" on a DR host', async () => {
    assert.equal(
      await getDisasterRecoveryUpdateRefusal(onDr, [CORE_HUB]),
      DR_UPDATE_BLOCKED_REASON,
    );
    assert.equal(
      await getDisasterRecoveryUpdateRefusal(onDr, ['a', CHRONOS]),
      DR_UPDATE_BLOCKED_REASON,
    );
    assert.equal(
      await getDisasterRecoveryUpdateRefusal(onDr, []),
      DR_UPDATE_BLOCKED_REASON,
    );
  });

  it('lets agents and the other services through on a DR host', async () => {
    assert.equal(
      await getDisasterRecoveryUpdateRefusal(onDr, [
        'gluesync-mssql-ct',
        'grafana',
      ]),
      null,
    );
    assert.equal(
      await getDisasterRecoveryUpdateRefusal(onDr, ['gluesync-conductor']),
      null,
    );
  });

  it('refuses nothing off a DR host', async () => {
    assert.equal(
      await getDisasterRecoveryUpdateRefusal(notDr, [CORE_HUB]),
      null,
    );
    assert.equal(await getDisasterRecoveryUpdateRefusal(notDr, []), null);
  });
});
