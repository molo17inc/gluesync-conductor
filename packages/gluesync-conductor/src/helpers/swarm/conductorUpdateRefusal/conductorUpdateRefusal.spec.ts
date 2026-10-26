import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import conductorUpdateRefusal from './conductorUpdateRefusal';

describe('conductorUpdateRefusal', () => {
  it('lets a newer release through', () => {
    assert.equal(conductorUpdateRefusal('0.14.0', '0.15.0'), null);
    assert.equal(conductorUpdateRefusal('0.9.0', '0.10.0'), null);
  });

  it('compares the release behind an image variant suffix', () => {
    assert.equal(conductorUpdateRefusal('0.14.0-alpine', '0.15.0'), null);
    assert.match(
      conductorUpdateRefusal('0.14.0-alpine', '0.13.2') ?? '',
      /not newer/,
    );
  });

  it('refuses a downgrade and names both versions', () => {
    const reason = conductorUpdateRefusal('0.14.0', '0.13.2');

    assert.match(reason ?? '', /0\.13\.2/);
    assert.match(reason ?? '', /0\.14\.0/);
    assert.match(reason ?? '', /not newer/);
  });

  it('has nothing to refuse when the target is the running version', () => {
    assert.equal(conductorUpdateRefusal('0.14.0', '0.14.0'), null);
    assert.equal(conductorUpdateRefusal('0.14.0-alpine', '0.14.0'), null);
  });

  it('refuses when the running version is not a release', () => {
    ['swarm-dev', 'latest', 'dev', ''].forEach(running => {
      assert.match(
        conductorUpdateRefusal(running, '0.13.2') ?? '',
        /not a release version/,
        running,
      );
    });
    assert.match(
      conductorUpdateRefusal(undefined, '0.13.2') ?? '',
      /not a release version/,
    );
  });

  it('refuses when there is no usable target', () => {
    assert.match(
      conductorUpdateRefusal('0.14.0', null) ?? '',
      /not a valid version/,
    );
    assert.match(
      conductorUpdateRefusal('0.14.0', 'nightly') ?? '',
      /not a valid version/,
    );
  });

  it('treats a prerelease of the running version as older', () => {
    assert.match(
      conductorUpdateRefusal('0.14.0', '0.14.0-beta.1') ?? '',
      /not newer/,
    );
  });
});
