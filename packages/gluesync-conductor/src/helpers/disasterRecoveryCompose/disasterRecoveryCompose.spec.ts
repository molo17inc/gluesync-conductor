import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DR_ENV_FILE_NAME,
  STOP_GRACE_PERIOD,
  applyDisasterRecoveryCompose,
  findDisasterRecoveryBlocker,
  removeDisasterRecoveryCompose,
  renderDisasterRecoveryEnvFile,
} from './disasterRecoveryCompose';
import type {
  DisasterRecoveryTargets,
  SiteVariables,
} from './disasterRecoveryCompose.model';

const targets: DisasterRecoveryTargets = {
  coreHub: 'gluesync-core-hub',
  chronos: 'gluesync-chronos',
  windows: false,
  controlScheme: 'http',
};

const ENV_FILES = [
  { path: '.env', required: false },
  { path: '/opt/gluesync-conductor/root-folder/.env', required: false },
];

// The shipped Linux kit: what the Core Hub and Chronos services of it look like
const kit = (): Record<string, any> => ({
  name: 'gluesync',
  services: {
    'gluesync-core-hub': {
      restart: 'unless-stopped',
      image: 'molo17/gluesync-core-hub:2.3.1.0',
      labels: ['com.molo17.conductor.type=core-hub'],
      environment: [
        'SSL_ENABLED=true',
        'LOG_CONFIG_FILE=/opt/gluesync/shared/logback.xml',
      ],
      volumes: [
        './shared:/opt/gluesync/shared',
        './bootstrap-core-hub.json:/opt/gluesync/data/bootstrap-core-hub.json',
        './logs/core-hub:/opt/gluesync/logs',
        './data/core-hub:/opt/gluesync/data',
      ],
      env_file: ENV_FILES.map(entry => ({ ...entry })),
      networks: ['gluesync-net'],
    },
    'gluesync-chronos': {
      restart: 'unless-stopped',
      image: 'molo17/gluesync-chronos:0.3.3',
      environment: ['SSL_ENABLED=true', 'SSL_SKIP_VERIFY=true', 'TIMEZONE=UTC'],
      volumes: [
        './shared:/opt/gluesync/shared:ro',
        './data/chronos:/app/data',
        './logs/chronos:/app/logs',
      ],
      env_file: ENV_FILES.map(entry => ({ ...entry })),
      networks: ['gluesync-net'],
    },
    'gluesync-conductor': { image: 'molo17/gluesync-conductor:0.14.1' },
  },
  networks: { 'gluesync-net': { name: 'gluesync-net' } },
});

const service = (compose: Record<string, any>, id: string): any =>
  compose.services[id];

describe('findDisasterRecoveryBlocker', () => {
  it('finds nothing in the shipped kit', () => {
    assert.equal(findDisasterRecoveryBlocker(kit(), targets), null);
  });

  it('wants the Core Hub and the Chronos services', () => {
    const noHub = kit();
    delete noHub.services['gluesync-core-hub'];
    const noChronos = kit();
    delete noChronos.services['gluesync-chronos'];

    assert.match(
      findDisasterRecoveryBlocker(noHub, targets) ?? '',
      /Core Hub service "gluesync-core-hub"/,
    );
    assert.match(
      findDisasterRecoveryBlocker(noChronos, targets) ?? '',
      /Chronos service "gluesync-chronos"/,
    );
    assert.match(
      findDisasterRecoveryBlocker({}, targets) ?? '',
      /Core Hub service/,
    );
  });

  it('wants Chronos to keep its data in a volume or folder Core Hub can share', () => {
    const none = kit();
    service(none, 'gluesync-chronos').volumes = [
      './shared:/opt/gluesync/shared:ro',
    ];
    const anonymous = kit();
    service(anonymous, 'gluesync-chronos').volumes = ['/app/data'];
    const tmpfs = kit();
    service(tmpfs, 'gluesync-chronos').volumes = [
      { type: 'tmpfs', target: '/app/data' },
    ];

    [none, anonymous, tmpfs].forEach(compose =>
      assert.match(
        findDisasterRecoveryBlocker(compose, targets) ?? '',
        /Chronos does not keep its data \(\/app\/data\)/,
      ),
    );
  });

  it('follows DATA_DIR when Chronos sets it', () => {
    const compose = kit();
    service(compose, 'gluesync-chronos').environment.push(
      'DATA_DIR=/srv/chronos',
    );

    assert.match(
      findDisasterRecoveryBlocker(compose, targets) ?? '',
      /\/srv\/chronos/,
    );

    service(compose, 'gluesync-chronos').volumes.push(
      'chronos-data:/srv/chronos',
    );

    assert.equal(findDisasterRecoveryBlocker(compose, targets), null);
  });

  it('refuses a Core Hub that already mounts something else where Chronos goes', () => {
    const compose = kit();
    service(compose, 'gluesync-core-hub').volumes.push(
      './other:/opt/gluesync/chronos',
    );

    assert.match(
      findDisasterRecoveryBlocker(compose, targets) ?? '',
      /already mounts something else at \/opt\/gluesync\/chronos/,
    );
  });

  it('refuses GS_DR_* variables set by hand in the Core Hub environment, list or map', () => {
    const list = kit();
    service(list, 'gluesync-core-hub').environment.push('GS_DR_ENABLED=false');
    const map = kit();
    service(map, 'gluesync-core-hub').environment = { GS_DR_NODE_ID: 'a' };

    [list, map].forEach(compose =>
      assert.match(
        findDisasterRecoveryBlocker(compose, targets) ?? '',
        /set by hand/,
      ),
    );
  });
});

describe('applyDisasterRecoveryCompose', () => {
  it('adds what a DR site needs to Core Hub and Chronos, and nothing else', () => {
    const before = kit();
    const after = applyDisasterRecoveryCompose(before, targets) as Record<
      string,
      any
    >;
    const hub = service(after, 'gluesync-core-hub');
    const chronos = service(after, 'gluesync-chronos');

    // the env file of the pair is read by Core Hub only, after the kit's own
    assert.deepEqual(hub.env_file, [
      ...ENV_FILES,
      { path: DR_ENV_FILE_NAME, required: false },
      {
        path: `/opt/gluesync-conductor/root-folder/${DR_ENV_FILE_NAME}`,
        required: false,
      },
    ]);
    assert.deepEqual(chronos.env_file, ENV_FILES);
    assert.deepEqual(hub.ports, ['1718:1718', '1719:1719']);
    assert.deepEqual(
      hub.volumes.slice(0, 4),
      before.services['gluesync-core-hub'].volumes,
    );
    assert.deepEqual(hub.volumes.slice(4), [
      './data/chronos:/opt/gluesync/chronos',
    ]);
    assert.equal(hub.stop_grace_period, STOP_GRACE_PERIOD);
    assert.deepEqual(chronos.environment, [
      ...before.services['gluesync-chronos'].environment,
      'GS_DR_CONTROL_URL=http://gluesync-core-hub:1719',
    ]);

    // everything else, and the secrets never, in the compose file
    assert.deepEqual(
      service(after, 'gluesync-conductor'),
      service(before, 'gluesync-conductor'),
    );
    assert.deepEqual(after.networks, before.networks);
    assert.ok(!JSON.stringify(after).includes('GS_DR_SHARED_SECRET'));
    assert.ok(!JSON.stringify(after).includes('GS_DR_ADMIN_TOKEN'));
    assert.deepEqual(service(before, 'gluesync-core-hub').volumes.length, 4);
  });

  it('does not change the compose file it is given', () => {
    const before = kit();

    applyDisasterRecoveryCompose(before, targets);

    assert.deepEqual(before, kit());
  });

  it('is idempotent: a second pass changes nothing', () => {
    const once = applyDisasterRecoveryCompose(kit(), targets);

    assert.deepEqual(applyDisasterRecoveryCompose(once, targets), once);
  });

  it('points Chronos at the control port over TLS when Core Hub runs with SSL', () => {
    const after = applyDisasterRecoveryCompose(kit(), {
      ...targets,
      controlScheme: 'https',
    }) as Record<string, any>;

    assert.ok(
      service(after, 'gluesync-chronos').environment.includes(
        'GS_DR_CONTROL_URL=https://gluesync-core-hub:1719',
      ),
    );
  });

  it('works on the map form of environment', () => {
    const compose = kit();
    service(compose, 'gluesync-chronos').environment = {
      TIMEZONE: 'UTC',
      GS_DR_CONTROL_URL: 'http://stale:1',
    };
    const after = applyDisasterRecoveryCompose(compose, targets) as Record<
      string,
      any
    >;

    assert.deepEqual(service(after, 'gluesync-chronos').environment, {
      TIMEZONE: 'UTC',
      GS_DR_CONTROL_URL: 'http://gluesync-core-hub:1719',
    });
  });

  it('works on a Core Hub without environment, env_file, ports or volumes', () => {
    const compose = kit();
    compose.services['gluesync-core-hub'] = {
      image: 'molo17/gluesync-core-hub:2',
    };
    const after = applyDisasterRecoveryCompose(compose, targets) as Record<
      string,
      any
    >;
    const hub = service(after, 'gluesync-core-hub');

    assert.equal(hub.env_file.length, 2);
    assert.deepEqual(hub.ports, ['1718:1718', '1719:1719']);
    assert.deepEqual(hub.volumes, ['./data/chronos:/opt/gluesync/chronos']);
  });

  it('turns a single env_file into a list and keeps it', () => {
    const compose = kit();
    service(compose, 'gluesync-core-hub').env_file = '.env';
    const after = applyDisasterRecoveryCompose(compose, targets) as Record<
      string,
      any
    >;

    assert.deepEqual(service(after, 'gluesync-core-hub').env_file[0], '.env');
    assert.equal(service(after, 'gluesync-core-hub').env_file.length, 3);
  });

  it('publishes each port once, however it is already written', () => {
    const compose = kit();
    service(compose, 'gluesync-core-hub').ports = [
      '8443:1717',
      '127.0.0.1:19719:1719/tcp',
      { target: 1718, published: 11718 },
    ];
    const after = applyDisasterRecoveryCompose(compose, targets) as Record<
      string,
      any
    >;

    assert.deepEqual(service(after, 'gluesync-core-hub').ports, [
      '8443:1717',
      '127.0.0.1:19719:1719/tcp',
      { target: 1718, published: 11718 },
    ]);
  });

  it('publishes on the host address Core Hub already publishes on', () => {
    const ipv4 = kit();
    service(ipv4, 'gluesync-core-hub').ports = ['10.0.0.1:1717:1717'];
    const ipv6 = kit();
    service(ipv6, 'gluesync-core-hub').ports = [
      { target: 1717, published: 1717, host_ip: '::1' },
    ];

    assert.deepEqual(
      (applyDisasterRecoveryCompose(ipv4, targets) as any).services[
        'gluesync-core-hub'
      ].ports,
      ['10.0.0.1:1717:1717', '10.0.0.1:1718:1718', '10.0.0.1:1719:1719'],
    );
    assert.deepEqual(
      (applyDisasterRecoveryCompose(ipv6, targets) as any).services[
        'gluesync-core-hub'
      ].ports.slice(1),
      ['[::1]:1718:1718', '[::1]:1719:1719'],
    );
  });

  it('mounts a named volume of Chronos the same way', () => {
    const compose = kit();
    service(compose, 'gluesync-chronos').volumes = ['chronos-data:/app/data'];
    const after = applyDisasterRecoveryCompose(compose, targets) as Record<
      string,
      any
    >;

    assert.deepEqual(service(after, 'gluesync-core-hub').volumes.slice(4), [
      'chronos-data:/opt/gluesync/chronos',
    ]);
  });

  it('mounts a long-syntax volume of Chronos the same way', () => {
    const compose = kit();
    service(compose, 'gluesync-chronos').volumes = [
      { type: 'volume', source: 'chronos-data', target: '/app/data/' },
    ];
    const after = applyDisasterRecoveryCompose(compose, targets) as Record<
      string,
      any
    >;

    assert.deepEqual(service(after, 'gluesync-core-hub').volumes.slice(4), [
      {
        type: 'volume',
        source: 'chronos-data',
        target: '/opt/gluesync/chronos',
      },
    ]);
  });

  it('keeps a grace period of a minute or more, raises a shorter one', () => {
    const longer = kit();
    service(longer, 'gluesync-core-hub').stop_grace_period = '2m';
    const shorter = kit();
    service(shorter, 'gluesync-core-hub').stop_grace_period = '30s';
    const odd = kit();
    service(odd, 'gluesync-core-hub').stop_grace_period = 'soon';

    const grace = (compose: Record<string, any>): unknown =>
      (applyDisasterRecoveryCompose(compose, targets) as any).services[
        'gluesync-core-hub'
      ].stop_grace_period;

    assert.equal(grace(longer), '2m');
    assert.equal(grace(shorter), '60s');
    assert.equal(grace(odd), 'soon');
    assert.equal(grace(kit()), '60s');
  });

  it('reads every shape of compose duration the same way: a minute or more stays, less is raised, what is not a duration stays', () => {
    const grace = (value: unknown): unknown => {
      const compose = kit();
      service(compose, 'gluesync-core-hub').stop_grace_period = value;

      return (applyDisasterRecoveryCompose(compose, targets) as any).services[
        'gluesync-core-hub'
      ].stop_grace_period;
    };
    const kept = [
      '60s',
      '1m',
      '1m0s',
      '0m60s',
      '1m30s',
      '30s30s',
      '30s1m',
      '1.5m',
      '0.5h',
      '1h',
      '60000ms',
      '59s1000ms',
      '60.0s',
      '  1m  ',
      // not a duration: left alone whatever number it holds
      '30',
      's',
      'm',
      '1',
      '1.s',
      '.5s',
      '1..5s',
      '1.5.5s',
      '1S',
      '1M',
      '1 m',
      '1m 30s',
      '10s 10s',
      'x1s',
      '1sx',
      '1s2',
      '1s.',
      '1,5s',
      '-1s',
      '+1s',
      '1e1s',
      '1µ',
      '1n',
      '1u',
      '1μs',
      '',
      '   ',
      'soon',
      'm1',
      '1ss',
      '1mss',
      '1hm',
    ];
    const raised = [
      '59s',
      '59.9s',
      '0s',
      '0.5m',
      '30s',
      '1s',
      '59999ms',
      '30000000us',
      '30000000µs',
      '30ns',
      '90us',
      '90µs',
      '10s20s',
      '10s10s10s',
      '  30s  ',
      '0m1ms',
      '00059s',
      '0.0000s',
    ];

    kept.forEach(value => {
      assert.equal(grace(value), value, `${JSON.stringify(value)} stays`);
    });

    raised.forEach(value => {
      assert.equal(
        grace(value),
        STOP_GRACE_PERIOD,
        `${JSON.stringify(value)} is raised`,
      );
    });
  });

  it('reads a very long value that is not a duration in no time', () => {
    const compose = kit();
    const hub = service(compose, 'gluesync-core-hub');

    [
      `${'1'.repeat(200_000)}x`,
      `${'1.'.repeat(100_000)}x`,
      `${'1s'.repeat(100_000)}1`,
      '1'.repeat(200_000),
    ].forEach(value => {
      hub.stop_grace_period = value;
      const started = Date.now();
      const after = applyDisasterRecoveryCompose(compose, targets) as any;

      assert.equal(
        after.services['gluesync-core-hub'].stop_grace_period,
        value,
      );
      assert.ok(Date.now() - started < 1000, 'it must not backtrack');
    });

    // and a long one that is a duration is summed
    hub.stop_grace_period = '1s'.repeat(100_000);
    assert.equal(
      (applyDisasterRecoveryCompose(compose, targets) as any).services[
        'gluesync-core-hub'
      ].stop_grace_period,
      '1s'.repeat(100_000),
    );
  });

  it('finds the Chronos mount of a long-syntax volume whatever slashes end its target', () => {
    const mountedWith = (target: string, windows = false): boolean => {
      const compose = kit();
      service(compose, 'gluesync-chronos').volumes = [
        { type: 'volume', source: 'chronos-data', target },
      ];

      return (
        findDisasterRecoveryBlocker(compose, { ...targets, windows }) === null
      );
    };

    assert.equal(mountedWith('/app/data'), true);
    assert.equal(mountedWith('/app/data/'), true);
    assert.equal(mountedWith('/app/data////'), true);
    assert.equal(mountedWith('/app/data\\'), true);
    assert.equal(mountedWith('/app/data\\/\\//'), true);
    assert.equal(mountedWith('/app/data/x'), false);
    assert.equal(mountedWith('/app/data/ '), false);
    assert.equal(mountedWith('//app/data'), false);
    assert.equal(mountedWith('/app/datax////'), false);
    assert.equal(mountedWith('////'), false);
    assert.equal(mountedWith(''), false);
    assert.equal(mountedWith(String.raw`C:\app\data`, true), true);
    assert.equal(mountedWith(String.raw`c:\APP\Data\\`, true), true);
    assert.equal(mountedWith(String.raw`C:\app\data\x`, true), false);
  });

  it('compares a very long target in no time', () => {
    const compose = kit();
    service(compose, 'gluesync-chronos').volumes = [
      {
        type: 'volume',
        source: 'chronos-data',
        target: `/app/data${'/'.repeat(100_000)}x`,
      },
    ];
    const started = Date.now();

    assert.notEqual(findDisasterRecoveryBlocker(compose, targets), null);
    assert.ok(Date.now() - started < 1000, 'it must not backtrack');
  });

  it('takes the Windows layout: Windows paths and the Windows root folder', () => {
    const windows = { ...targets, windows: true };
    const compose = kit();
    service(compose, 'gluesync-chronos').volumes = [
      String.raw`./data/chronos:C:\app\data`,
    ];
    const after = applyDisasterRecoveryCompose(compose, windows) as Record<
      string,
      any
    >;
    const hub = service(after, 'gluesync-core-hub');

    assert.deepEqual(hub.volumes.slice(4), [
      String.raw`./data/chronos:C:\opt\gluesync\chronos`,
    ]);
    assert.equal(
      hub.env_file.at(-1).path,
      String.raw`C:\opt\gluesync-conductor\root-folder\gluesync-dr.env`,
    );
    assert.deepEqual(applyDisasterRecoveryCompose(after, windows), after);
  });

  it('throws what findDisasterRecoveryBlocker finds', () => {
    const compose = kit();
    delete compose.services['gluesync-chronos'];

    assert.throws(
      () => applyDisasterRecoveryCompose(compose, targets),
      /Chronos service/,
    );
  });
});

describe('removeDisasterRecoveryCompose', () => {
  it('restores the shipped kit as it was', () => {
    const applied = applyDisasterRecoveryCompose(kit(), targets);

    assert.deepEqual(removeDisasterRecoveryCompose(applied, targets), kit());
  });

  it('is idempotent, and a no-op on a compose file that never had it', () => {
    const removed = removeDisasterRecoveryCompose(
      applyDisasterRecoveryCompose(kit(), targets),
      targets,
    );

    assert.deepEqual(removeDisasterRecoveryCompose(removed, targets), kit());
    assert.deepEqual(removeDisasterRecoveryCompose(kit(), targets), kit());
  });

  it('restores the map form of environment, with or without other variables', () => {
    const withOthers = kit();
    service(withOthers, 'gluesync-chronos').environment = { TIMEZONE: 'UTC' };
    const alone = kit();
    delete service(alone, 'gluesync-chronos').environment;

    [withOthers, alone].forEach(compose =>
      assert.deepEqual(
        removeDisasterRecoveryCompose(
          applyDisasterRecoveryCompose(compose, targets),
          targets,
        ),
        compose,
      ),
    );
  });

  it('keeps what the customer added around the setup, and a grace period of their own', () => {
    const customer = kit();
    service(customer, 'gluesync-core-hub').ports = ['8443:1717'];
    service(customer, 'gluesync-core-hub').stop_grace_period = '5m';
    service(customer, 'gluesync-core-hub').volumes.push('./extra:/extra');
    service(customer, 'gluesync-core-hub').env_file.push({ path: 'mine.env' });
    service(customer, 'gluesync-chronos').environment.push('MINE=1');

    assert.deepEqual(
      removeDisasterRecoveryCompose(
        applyDisasterRecoveryCompose(customer, targets),
        targets,
      ),
      customer,
    );
  });

  it('drops a single remaining env_file as a list of one', () => {
    const compose = kit();
    service(compose, 'gluesync-core-hub').env_file = '.env';
    const removed = removeDisasterRecoveryCompose(
      applyDisasterRecoveryCompose(compose, targets),
      targets,
    ) as Record<string, any>;

    assert.deepEqual(service(removed, 'gluesync-core-hub').env_file, ['.env']);
  });

  it('removes the env_file key when the setup file was all there was', () => {
    const compose = kit();
    delete service(compose, 'gluesync-core-hub').env_file;
    const removed = removeDisasterRecoveryCompose(
      applyDisasterRecoveryCompose(compose, targets),
      targets,
    ) as Record<string, any>;

    assert.ok(!('env_file' in service(removed, 'gluesync-core-hub')));
  });

  it('removes the Windows mount and the sink and control ports on any host address', () => {
    const windows = { ...targets, windows: true };
    const compose = kit();
    service(compose, 'gluesync-chronos').volumes = [
      String.raw`./data/chronos:C:\app\data`,
    ];
    service(compose, 'gluesync-core-hub').ports = ['10.0.0.1:1717:1717'];

    assert.deepEqual(
      removeDisasterRecoveryCompose(
        applyDisasterRecoveryCompose(compose, windows),
        windows,
      ),
      compose,
    );
  });
});

describe('renderDisasterRecoveryEnvFile', () => {
  const variables: SiteVariables = {
    nodeId: 'site-a',
    peerUrl: 'http://10.0.0.2:1717',
    failoverMode: 'manual',
    witnessUrl: null,
    leaseTtlSeconds: 30,
    sharedSecret: 'q8Zr0yKc-mP3v_XtN2bHsLw9aUeD5fGjR7oIiYkTnVA',
    adminToken: 'Zt3kLw9aUeD5fGjR7oIiYkTnVAq8Zr0yKc-mP3v_XtN',
    bootstrapActive: true,
    chronosDir: '/opt/gluesync/chronos',
  };

  const parse = (text: string): Record<string, string> =>
    Object.fromEntries(
      text
        .split('\n')
        .filter(line => line && !line.startsWith('#'))
        .map(line => [
          line.slice(0, line.indexOf('=')),
          line.slice(line.indexOf('=') + 1),
        ]),
    );

  it('writes the variables of the first site, marked as written by the Conductor', () => {
    const text = renderDisasterRecoveryEnvFile(variables);

    assert.ok(text.endsWith('\n'));
    assert.deepEqual(parse(text), {
      GS_DR_MANAGED_BY: 'conductor',
      GS_DR_ENABLED: 'true',
      GS_DR_NODE_ID: 'site-a',
      GS_DR_PEER_URL: 'http://10.0.0.2:1717',
      GS_DR_FAILOVER_MODE: 'manual',
      GS_DR_SHARED_SECRET: variables.sharedSecret,
      GS_DR_ADMIN_TOKEN: variables.adminToken,
      GS_DR_BOOTSTRAP_ACTIVE: 'true',
      GS_DR_CHRONOS_DIR: '/opt/gluesync/chronos',
    });
  });

  it('records what the pairing code needs only for the first site, with the lease even in a manual pair', () => {
    const first = parse(
      renderDisasterRecoveryEnvFile({
        ...variables,
        leaseTtlSeconds: 45,
        pairing: { thisSiteUrl: 'http://10.0.0.1:1717', peerNodeId: 'site-b' },
      }),
    );
    const joiner = parse(renderDisasterRecoveryEnvFile(variables));

    assert.equal(first.GS_DR_PAIRING_FIRST_URL, 'http://10.0.0.1:1717');
    assert.equal(first.GS_DR_PAIRING_JOINER_NODE_ID, 'site-b');
    assert.equal(first.GS_DR_PAIRING_LEASE_TTL_SECONDS, '45');
    assert.ok(!('GS_DR_LEASE_TTL_SECONDS' in first));
    assert.ok(
      !Object.keys(joiner).some(key => key.startsWith('GS_DR_PAIRING')),
    );
  });

  it('has no bootstrap flag on the joining site, and the witness and lease only with a witness', () => {
    const joiner = parse(
      renderDisasterRecoveryEnvFile({ ...variables, bootstrapActive: false }),
    );
    const witness = parse(
      renderDisasterRecoveryEnvFile({
        ...variables,
        failoverMode: 'witness',
        witnessUrl: 'https://witness.example.com:8443',
        leaseTtlSeconds: 45,
      }),
    );

    assert.ok(!('GS_DR_BOOTSTRAP_ACTIVE' in joiner));
    assert.ok(!('GS_DR_WITNESS_URL' in joiner));
    assert.ok(!('GS_DR_LEASE_TTL_SECONDS' in joiner));
    assert.equal(witness.GS_DR_FAILOVER_MODE, 'witness');
    assert.equal(witness.GS_DR_WITNESS_URL, 'https://witness.example.com:8443');
    assert.equal(witness.GS_DR_LEASE_TTL_SECONDS, '45');
  });

  it('quotes a Windows path so that its backslashes are literal', () => {
    const text = renderDisasterRecoveryEnvFile({
      ...variables,
      chronosDir: String.raw`C:\opt\gluesync\chronos`,
    });

    assert.match(text, /^GS_DR_CHRONOS_DIR='C:\\opt\\gluesync\\chronos'$/m);
  });

  it('refuses a value that would break the file or be expanded by compose', () => {
    [
      'a\nGS_DR_ENABLED=false',
      'a b',
      '$HOME',
      'a"b',
      "a'b",
      'a#b',
      '`x`',
      '',
    ].forEach(sharedSecret =>
      assert.throws(
        () => renderDisasterRecoveryEnvFile({ ...variables, sharedSecret }),
        /GS_DR_SHARED_SECRET/,
        JSON.stringify(sharedSecret),
      ),
    );
  });
});
