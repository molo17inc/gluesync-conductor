import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import extractKeyValue from './extractKeyValue';

describe('extractKeyValue', () => {
  it('reads short entries and casts the values', () => {
    assert.deepEqual(extractKeyValue('=', ['A=1', 'B=true', 'C=x=y']), {
      A: 1,
      B: true,
      C: 'x=y',
    });
  });

  it('ignores short entries without the separator', () => {
    assert.deepEqual(extractKeyValue(':', ['/data', '80:80']), { 80: 80 });
  });

  it('passes an object (map syntax) through', () => {
    assert.deepEqual(extractKeyValue('=', { A: '1' }), { A: '1' });
  });

  describe('long-syntax volumes', () => {
    it('maps source and target, with :ro when read only', () => {
      assert.deepEqual(
        extractKeyValue(
          ':',
          [
            { type: 'bind', source: './conf', target: '/etc/conf' },
            {
              type: 'volume',
              source: 'data',
              target: '/var/lib/data',
              read_only: true,
            },
            {
              type: 'volume',
              source: 'logs',
              target: '/logs',
              read_only: false,
            },
          ],
          'volumes',
        ),
        {
          './conf': '/etc/conf',
          data: '/var/lib/data:ro',
          logs: '/logs',
        },
      );
    });

    it('mixes with short entries', () => {
      assert.deepEqual(
        extractKeyValue(
          ':',
          ['/a:/b:ro', { source: 'v', target: '/c' }],
          'volumes',
        ),
        { '/a': '/b:ro', v: '/c' },
      );
    });

    it('skips entries without a source or a target, without throwing', () => {
      assert.deepEqual(
        extractKeyValue(
          ':',
          [{ type: 'tmpfs', target: '/tmp' }, { source: 'x' } as any],
          'volumes',
        ),
        {},
      );
    });
  });

  describe('long-syntax ports', () => {
    it('maps published to target, adding the protocol unless it is tcp', () => {
      assert.deepEqual(
        extractKeyValue(
          ':',
          [
            { target: 80, published: 8080, protocol: 'tcp', mode: 'host' },
            { target: 53, published: 5353, protocol: 'udp' },
            { target: 9000, published: '9000-9001' },
          ],
          'ports',
        ),
        { 8080: 80, 5353: '53/udp', '9000-9001': 9000 },
      );
    });

    it('uses an empty host for a port that is not published', () => {
      assert.deepEqual(extractKeyValue(':', [{ target: 3000 }], 'ports'), {
        '': 3000,
      });
    });

    it('skips an entry without a target', () => {
      assert.deepEqual(
        extractKeyValue(':', [{ published: 80 } as any], 'ports'),
        {},
      );
    });
  });

  it('skips objects where the field has no long syntax, without throwing', () => {
    assert.deepEqual(
      extractKeyValue('=', [{ foo: 'bar' }, 'A=1'] as any, 'environment'),
      { A: 1 },
    );
    assert.deepEqual(extractKeyValue('=', [{ foo: 'bar' }] as any), {});
  });

  it('skips null entries', () => {
    assert.deepEqual(extractKeyValue('=', [null, 'A=1'] as any), { A: 1 });
  });
});
