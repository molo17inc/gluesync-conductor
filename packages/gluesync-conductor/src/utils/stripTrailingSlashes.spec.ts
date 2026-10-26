import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import stripTrailingSlashes from './stripTrailingSlashes';

describe('stripTrailingSlashes', () => {
  it('removes every trailing slash and nothing else', () => {
    assert.equal(stripTrailingSlashes('https://host/'), 'https://host');
    assert.equal(stripTrailingSlashes('https://host///'), 'https://host');
    assert.equal(stripTrailingSlashes('https://host/a/b'), 'https://host/a/b');
    assert.equal(stripTrailingSlashes('/a//b/'), '/a//b');
  });

  it('handles empty and slash-only input', () => {
    assert.equal(stripTrailingSlashes(''), '');
    assert.equal(stripTrailingSlashes('////'), '');
  });

  it('stays linear on a long run of slashes', () => {
    const startedAt = Date.now();
    assert.equal(stripTrailingSlashes(`x${'/'.repeat(500_000)}`), 'x');
    assert.equal(
      stripTrailingSlashes(`${'/'.repeat(500_000)}x`),
      `${'/'.repeat(500_000)}x`,
    );
    assert.ok(Date.now() - startedAt < 1000);
  });
});
