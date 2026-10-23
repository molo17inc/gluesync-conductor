import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeProxyUrl, redactSecrets } from './redact';

describe('redactSecrets', () => {
  it('masks user:password in any URL inside free text', () => {
    assert.equal(
      redactSecrets('connect failed via http://alice:S3CR3T@proxy.corp:3128'),
      'connect failed via http://***:***@proxy.corp:3128',
    );
  });

  it('masks a username without a password', () => {
    assert.equal(
      redactSecrets('http://alice@proxy.corp:3128'),
      'http://***:***@proxy.corp:3128',
    );
  });

  it('masks a token with an empty username', () => {
    assert.equal(
      redactSecrets('via http://:T0KEN@proxy.corp:3128'),
      'via http://***:***@proxy.corp:3128',
    );
  });

  it('leaves text without credentials untouched', () => {
    const text =
      'timeout of 5000ms exceeded for https://api.backoffice.molo17.com/x';
    assert.equal(redactSecrets(text), text);
  });
});

describe('describeProxyUrl', () => {
  it('keeps host, port and whether credentials exist, never the credentials', () => {
    const described = describeProxyUrl('http://alice:S3CR3T@proxy.corp:3128');

    assert.deepEqual(described, {
      host: 'proxy.corp',
      port: 3128,
      authenticated: true,
    });
    assert.ok(!JSON.stringify(described).includes('S3CR3T'));
  });

  it('infers the default port from the protocol', () => {
    assert.equal(describeProxyUrl('http://proxy.corp')?.port, 80);
    assert.equal(describeProxyUrl('https://proxy.corp')?.port, 443);
  });

  it('returns undefined for something that is not a URL', () => {
    assert.equal(describeProxyUrl('not a url'), undefined);
  });
});
