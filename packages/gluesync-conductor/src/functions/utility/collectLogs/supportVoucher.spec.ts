import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizeTicketKey,
  normalizeVoucher,
  redactVouchers,
} from './supportVoucher';

describe('normalizeVoucher', () => {
  const cases: ReadonlyArray<readonly [string, string, string | null]> = [
    ['the canonical form', 'GSV-ABCD-EFGH-JKMN', 'GSV-ABCD-EFGH-JKMN'],
    ['lower case', 'gsv-abcd-efgh-jkmn', 'GSV-ABCD-EFGH-JKMN'],
    ['surrounding whitespace', '  GSV-ABCD-EFGH-JKMN\n', 'GSV-ABCD-EFGH-JKMN'],
    ['spaces instead of dashes', 'GSV ABCD EFGH JKMN', 'GSV-ABCD-EFGH-JKMN'],
    ['no separators at all', 'GSVABCDEFGHJKMN', 'GSV-ABCD-EFGH-JKMN'],
    ['without the prefix', 'ABCD-EFGH-JKMN', 'GSV-ABCD-EFGH-JKMN'],
    ['a bare 12-character code', 'ABCDEFGHJKMN', 'GSV-ABCD-EFGH-JKMN'],
    [
      'a bare code that starts with GSV (kept, not stripped)',
      'GSV0ABCDEFGH',
      'GSV-GSV0-ABCD-EFGH',
    ],
    [
      'the same code written with the prefix',
      'GSV-GSV0-ABCD-EFGH',
      'GSV-GSV0-ABCD-EFGH',
    ],
    ['O read as 0', 'GSV-OOOO-ABCD-EFGH', 'GSV-0000-ABCD-EFGH'],
    ['I and L read as 1', 'GSV-IL1L-ABCD-EFGH', 'GSV-1111-ABCD-EFGH'],
    ['lookalikes without the prefix', 'olil-abcd-efgh', 'GSV-0111-ABCD-EFGH'],
    ['a code too short', 'GSV-ABCD-EFGH-JKM', null],
    ['a code too long', 'GSV-ABCD-EFGH-JKMNP', null],
    ['eleven characters after the prefix', 'GSV-ABCD-EFGH-JK', null],
    ['a character outside the alphabet (U)', 'GSV-ABCD-EFGH-JKMU', null],
    ['a character outside the alphabet (symbol)', 'GSV-ABCD-EFGH-JK!N', null],
    ['an empty string', '', null],
    ['only dashes and spaces', ' - - ', null],
    ['the prefix alone', 'GSV', null],
  ];

  cases.forEach(([name, input, expected]) => {
    it(`${expected === null ? 'rejects' : 'reads'} ${name}`, () => {
      assert.equal(normalizeVoucher(input), expected);
    });
  });
});

describe('normalizeTicketKey', () => {
  const cases: ReadonlyArray<readonly [string, string | null]> = [
    ['GSSD-1234', 'GSSD-1234'],
    ['gssd-1234', 'GSSD-1234'],
    ['1234', 'GSSD-1234'],
    ['#1234', 'GSSD-1234'],
    ['  #1234  ', 'GSSD-1234'],
    ['#gssd-77', 'GSSD-77'],
    ['ABC-9', 'ABC-9'],
    ['', null],
    ['#', null],
    ['GSSD-', null],
    ['GSSD-12a', null],
    ['-12', null],
    ['1234567890123', null],
    ['GSSD 12', null],
  ];

  cases.forEach(([input, expected]) => {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      assert.equal(normalizeTicketKey(input), expected);
    });
  });
});

describe('redactVouchers', () => {
  it('masks every voucher-shaped text', () => {
    assert.equal(
      redactVouchers('bad GSV-ABCD-EFGH-JKMN and gsv-1111-2222-3333 here'),
      'bad GSV-****-****-**** and GSV-****-****-**** here',
    );
  });

  it('leaves other text alone', () => {
    assert.equal(redactVouchers('nothing to hide'), 'nothing to hide');
  });
});
