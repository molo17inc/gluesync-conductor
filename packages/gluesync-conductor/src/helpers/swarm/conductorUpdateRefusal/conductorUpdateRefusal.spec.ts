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

  describe('switching release channel', () => {
    it('moves an alpha build to the beta or GA release of its version', () => {
      assert.equal(conductorUpdateRefusal('0.14.0.814e5b87', '0.14.0'), null);
    });

    it('moves an alpha build to a newer release or a newer alpha', () => {
      assert.equal(conductorUpdateRefusal('0.14.0.814e5b87', '0.15.0'), null);
      assert.equal(
        conductorUpdateRefusal('0.14.0.814e5b87', '0.15.0.a1b2c3d4'),
        null,
      );
    });

    it('moves a release to the alpha of a newer version', () => {
      assert.equal(conductorUpdateRefusal('0.14.0', '0.15.0.a1b2c3d4'), null);
    });

    it('does not move a release back to an alpha build of its own version', () => {
      assert.match(
        conductorUpdateRefusal('0.14.0', '0.14.0.814e5b87') ?? '',
        /not newer/,
      );
    });

    it('refuses an older release from an alpha build', () => {
      const reason = conductorUpdateRefusal('0.14.0.814e5b87', '0.13.2');

      assert.match(reason ?? '', /not newer/);
      assert.match(reason ?? '', /0\.14\.0\.814e5b87/);
    });

    it('refuses another alpha build of the same version', () => {
      assert.match(
        conductorUpdateRefusal('0.14.0.814e5b87', '0.14.0.a1b2c3d4') ?? '',
        /both alpha builds of 0\.14\.0/,
      );
    });

    it('has nothing to refuse when the alpha build is the running one', () => {
      assert.equal(
        conductorUpdateRefusal('0.14.0.814e5b87', '0.14.0.814e5b87'),
        null,
      );
    });

    it('reads the alpha build behind a Windows image variant', () => {
      assert.equal(
        conductorUpdateRefusal(
          '0.14.0.814e5b87-win-nanoserver-ltsc2022',
          '0.14.0',
        ),
        null,
      );
    });

    it('accepts a commit made of digits only', () => {
      assert.equal(conductorUpdateRefusal('0.14.0.0123456', '0.14.0'), null);
    });

    it('still refuses a tag that is no version, like develop', () => {
      assert.match(
        conductorUpdateRefusal('develop', '0.15.0') ?? '',
        /not a release version/,
      );
    });
  });
});
