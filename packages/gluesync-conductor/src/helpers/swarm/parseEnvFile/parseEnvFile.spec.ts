import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import parseEnvFile from './parseEnvFile';

describe('parseEnvFile', () => {
  it('reads KEY=VALUE lines', () => {
    assert.deepEqual(parseEnvFile('A=1\nB=two\nC='), {
      A: '1',
      B: 'two',
      C: '',
    });
  });

  it('skips blank lines and comments', () => {
    assert.deepEqual(
      parseEnvFile('# the hub\n\n  # indented\nA=1\n   \nB=2\n'),
      { A: '1', B: '2' },
    );
  });

  it('strips one pair of surrounding quotes', () => {
    assert.deepEqual(parseEnvFile(`A="x y"\nB='z'\nC="it's"\nD=" padded "`), {
      A: 'x y',
      B: 'z',
      C: "it's",
      D: ' padded ',
    });
  });

  it('keeps an equals sign inside the value', () => {
    assert.deepEqual(parseEnvFile('URL=jdbc:x://h?a=b&c=d'), {
      URL: 'jdbc:x://h?a=b&c=d',
    });
  });

  it('handles Windows line endings and spaces around the key', () => {
    assert.deepEqual(parseEnvFile('A=1\r\n  B = 2 \r\n'), { A: '1', B: '2' });
  });

  it('accepts an export prefix', () => {
    assert.deepEqual(parseEnvFile('export A=1'), { A: '1' });
  });

  it('cuts an unquoted value at a space-hash comment only', () => {
    assert.deepEqual(parseEnvFile('A=1 # note\nB=a#b\nC="x # y"'), {
      A: '1',
      B: 'a#b',
      C: 'x # y',
    });
  });

  it('ignores lines that are not assignments', () => {
    assert.deepEqual(parseEnvFile('just words\n=novalue\n1BAD=x\nOK=1'), {
      OK: '1',
    });
  });

  it('keeps export as a key when nothing follows it and as a prefix otherwise', () => {
    assert.deepEqual(
      parseEnvFile('export=1\nexportA=2\nexport   B=3\nexport A B=4'),
      {
        export: '1',
        exportA: '2',
        B: '3',
      },
    );
  });

  it('reads long lines of spaces and quotes in linear time', () => {
    const spaces = ' '.repeat(200_000);
    const started = Date.now();

    assert.deepEqual(
      parseEnvFile(
        [
          `A=x${spaces}y`,
          `B${spaces}`,
          `export${spaces}`,
          `C=${spaces}#`,
          `D=${'"'.repeat(200_000)}`,
          `E=${"'".repeat(200_000)} x`,
        ].join('\n'),
      ),
      {
        A: `x${spaces}y`,
        C: '#',
        D: '"'.repeat(199_998),
        E: "'".repeat(199_998),
      },
    );
    assert.ok(Date.now() - started < 2000);
  });

  it('lets a later line win', () => {
    assert.deepEqual(parseEnvFile('A=1\nA=2'), { A: '2' });
  });
});
