/* eslint-disable functional/immutable-data -- recorders for the test */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  HealChronosScrapeDeps,
  healChronosScrapeWith,
  resolvePrometheusConfPath,
} from './healChronosScrape';
import planChronosScrape, { chronosTarget } from './planChronosScrape';

const KIT_PROMETHEUS = `global:
  scrape_interval: 5s
scrape_configs:
  - job_name: prometheus
    metrics_path: "/prometheus/metrics"
    static_configs:
      - targets:
          - prometheus:9090
  - job_name: gluesync-core-hub
    # decomment in case you're using HTTPS
    scheme: https
    tls_config:
      insecure_skip_verify: true # use it in case you're adopting self-signed certs
    static_configs:
      - targets:
          - gluesync-core-hub:1717
`;

const HTTPS = {
  scheme: 'https',
  host: 'gluesync-chronos',
  port: 1717,
} as const;

describe('chronosTarget', () => {
  it('follows SSL_ENABLED and PORT, list or map environment', () => {
    assert.deepEqual(
      chronosTarget('gluesync-chronos', {
        environment: ['SSL_ENABLED=true', 'PORT=1818'],
      }),
      { scheme: 'https', host: 'gluesync-chronos', port: 1818 },
    );
    assert.deepEqual(
      chronosTarget('c', { environment: { SSL_ENABLED: 'False' } } as never),
      { scheme: 'http', host: 'c', port: 1717 },
    );
    assert.deepEqual(chronosTarget('c', {}), {
      scheme: 'http',
      host: 'c',
      port: 1717,
    });
    assert.deepEqual(
      chronosTarget('c', {
        environment: ['SSL_ENABLED', 'PORT=abc', 7],
      } as never),
      { scheme: 'http', host: 'c', port: 1717 },
    );
    assert.deepEqual(
      chronosTarget('c', { environment: { SSL_ENABLED: null } } as never)
        .scheme,
      'http',
    );
  });
});

describe('planChronosScrape', () => {
  it('appends the job after the last one and keeps every other byte', () => {
    const plan = planChronosScrape(KIT_PROMETHEUS, HTTPS);

    assert.equal(plan.action, 'add');
    assert.ok(
      plan.action === 'add' && plan.text.startsWith(KIT_PROMETHEUS.trimEnd()),
    );
    assert.ok(
      plan.action === 'add' &&
        plan.text.endsWith(
          [
            '  - job_name: gluesync-chronos',
            '    # Chronos (scheduler) /metrics, added by Gluesync Conductor',
            '    scheme: https',
            '    tls_config:',
            '      insecure_skip_verify: true',
            '    static_configs:',
            '      - targets:',
            '          - gluesync-chronos:1717',
            '',
          ].join('\n'),
        ),
    );
    // Applying the plan twice changes nothing
    assert.equal(
      plan.action === 'add' && planChronosScrape(plan.text, HTTPS).action,
      'none',
    );
  });

  it('keeps what follows scrape_configs and the CRLF line endings', () => {
    const crlf = `scrape_configs:\r\n- job_name: a\r\n  static_configs:\r\n  - targets: [a:1]\r\nrule_files:\r\n- x.yml\r\n`;
    const plan = planChronosScrape(crlf, {
      scheme: 'http',
      host: 'gluesync-chronos',
      port: 1717,
    });

    assert.equal(plan.action, 'add');
    const text = plan.action === 'add' ? plan.text : '';
    assert.ok(text.includes('- job_name: gluesync-chronos\r\n  # Chronos'));
    assert.ok(!text.includes('tls_config'));
    assert.ok(text.endsWith('rule_files:\r\n- x.yml\r\n'));
    assert.ok(!/[^\r]\n/.test(text));
  });

  it('leaves the file alone when Chronos is already scraped or the file is unexpected', () => {
    const named = `${KIT_PROMETHEUS}  - job_name: gluesync-chronos\n`;
    const byTarget = `${
      KIT_PROMETHEUS
    }  - job_name: scheduler\n    static_configs:\n      - targets: ["gluesync-chronos:9999"]\n`;
    assert.deepEqual(planChronosScrape(named, HTTPS), {
      action: 'none',
      reason: 'Chronos is already scraped',
    });
    assert.equal(planChronosScrape(byTarget, HTTPS).action, 'none');
    assert.match(
      String((planChronosScrape('a: [', HTTPS) as { reason: string }).reason),
      /not valid YAML/,
    );
    assert.equal(
      (planChronosScrape('global: {}\n', HTTPS) as { reason: string }).reason,
      'prometheus.yml has no scrape_configs list',
    );
    assert.equal(
      (
        planChronosScrape('scrape_configs: [{job_name: a}]\n', HTTPS) as {
          reason: string;
        }
      ).reason,
      'scrape_configs is a flow-style list',
    );
    assert.equal(
      (planChronosScrape('scrape_configs:\n', HTTPS) as { reason: string })
        .reason,
      'prometheus.yml has no scrape_configs list',
    );
  });
});

const deps = (over: Partial<HealChronosScrapeDeps> = {}) => {
  const writes: Array<[string, string]> = [];
  const restarts: string[] = [];
  const base: HealChronosScrapeDeps = {
    readCompose: async () => ({
      services: {
        'gluesync-chronos': {
          image: 'molo17/gluesync-chronos:0.3.6',
          environment: ['SSL_ENABLED=true'],
        },
        prometheus: {
          image: 'molo17/prometheus:3.16.0',
          volumes: [
            './prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro',
          ],
        },
      },
    }),
    exists: path => path.endsWith('prometheus/prometheus.yml'),
    read: async () => KIT_PROMETHEUS,
    write: async (path, text) => {
      writes.push([path, text]);
    },
    servesMetrics: async () => true,
    restartService: async name => {
      restarts.push(name);
      return 1;
    },
  };
  return { deps: { ...base, ...over }, writes, restarts };
};

describe('healChronosScrapeWith', () => {
  it('adds the job and restarts Prometheus', async () => {
    const { deps: d, writes, restarts } = deps();
    const outcome = await healChronosScrapeWith(d);

    assert.equal(outcome.action, 'add');
    assert.equal(outcome.prometheus, 'prometheus');
    assert.equal(writes.length, 1);
    assert.match(
      writes[0][0],
      /root-folder[\\/]prometheus[\\/]prometheus\.yml$/,
    );
    assert.ok(writes[0][1].includes('gluesync-chronos:1717'));
    assert.deepEqual(restarts, ['prometheus']);
  });

  it('does nothing while Chronos has no /metrics yet', async () => {
    const { deps: d, writes } = deps({ servesMetrics: async () => false });
    const outcome = await healChronosScrapeWith(d);
    assert.equal(outcome.action, 'none');
    assert.match(outcome.reason, /does not serve \/metrics/);
    assert.equal(writes.length, 0);
  });

  it('does nothing without Chronos, Prometheus or a reachable configuration', async () => {
    const noChronos = deps({
      readCompose: async () => ({
        services: { prometheus: { image: 'prom/prometheus' } },
      }),
    });
    assert.equal(
      (await healChronosScrapeWith(noChronos.deps)).reason,
      'no Chronos service in the stack',
    );

    const noProm = deps({
      readCompose: async () => ({
        services: { scheduler: { image: 'molo17/gluesync-chronos:1' } },
      }),
    });
    assert.equal(
      (await healChronosScrapeWith(noProm.deps)).reason,
      'no Prometheus service in the stack',
    );

    const noFile = deps({ exists: () => false });
    assert.equal(
      (await healChronosScrapeWith(noFile.deps)).reason,
      'the Prometheus configuration file is not reachable',
    );

    const already = deps({
      read: async () => `${KIT_PROMETHEUS}  - job_name: gluesync-chronos\n`,
    });
    assert.equal((await healChronosScrapeWith(already.deps)).action, 'none');
    assert.equal(already.writes.length, 0);
  });
});

describe('resolvePrometheusConfPath', () => {
  it('maps file and folder mounts to the Conductor root folder, then falls back to the kit path', () => {
    const all = () => true;
    assert.match(
      String(
        resolvePrometheusConfPath(
          {
            volumes: [
              './prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro',
            ],
          },
          all,
        ),
      ),
      /root-folder[\\/]prometheus[\\/]prometheus\.yml$/,
    );
    assert.equal(
      resolvePrometheusConfPath(
        { volumes: ['/srv/prom:/etc/prometheus'] },
        all,
      ),
      '/srv/prom/prometheus.yml',
    );
    assert.match(
      String(
        resolvePrometheusConfPath({ volumes: ['data:/prometheus'] }, p =>
          p.includes('root-folder'),
        ),
      ),
      /root-folder[\\/]prometheus[\\/]prometheus\.yml$/,
    );
    assert.equal(
      resolvePrometheusConfPath(undefined, () => false),
      null,
    );
  });
});
