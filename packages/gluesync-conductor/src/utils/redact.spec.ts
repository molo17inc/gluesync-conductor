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

  it('masks credentials behind a scheme that starts with non-letters', () => {
    assert.equal(
      redactSecrets('1http://alice:S3CR3T@proxy'),
      '1http://***:***@proxy',
    );
    assert.equal(
      redactSecrets('x-9.y+z://alice@proxy and ftp://bob:pw@h'),
      'x-9.y+z://***:***@proxy and ftp://***:***@h',
    );
  });

  it('masks several URLs and passwords containing colons', () => {
    assert.equal(
      redactSecrets('a http://u:p:w@h1 b https://v:q@h2/x'),
      'a http://***:***@h1 b https://***:***@h2/x',
    );
  });

  it('does not mask an @ that is not in the authority', () => {
    const text = 'see http://host/path@x and mail me@host';
    assert.equal(redactSecrets(text), text);
  });

  it('stays linear on long adversarial input', () => {
    const inputs = [
      'a'.repeat(200_000),
      '1a'.repeat(100_000),
      `http://${'x'.repeat(200_000)}`,
      'a://'.repeat(50_000),
      `${'a:'.repeat(100_000)}@`,
    ];
    const startedAt = Date.now();

    inputs.forEach(redactSecrets);

    assert.ok(Date.now() - startedAt < 2000);
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
