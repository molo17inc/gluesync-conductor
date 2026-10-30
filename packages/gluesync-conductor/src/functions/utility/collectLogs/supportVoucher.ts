// The shape of a support-portal voucher and of a ticket key, exactly as the
// portal and every other client (Core Hub, Gluesync Control) read them.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;
const GROUP_LENGTH = 4;
const PREFIX = 'GSV';
const DEFAULT_TICKET_PROJECT = 'GSSD';
const TICKET_KEY_SHAPE = /^[A-Z][A-Z0-9]{0,15}-\d{1,12}$/;
const ONLY_DIGITS = /^\d+$/;
const LOOKALIKES: Readonly<Record<string, string>> = {
  O: '0',
  I: '1',
  L: '1',
};

/**
 * `GSV-XXXX-XXXX-XXXX` for what a person typed or pasted, or null when it is
 * not a voucher: trim, uppercase, drop spaces and dashes, drop a leading `GSV`
 * only when 15 characters remain (a bare 12-character code that itself starts
 * with `GSV` is kept), read O as 0 and I and L as 1, then exactly 12
 * characters of the Crockford base32 alphabet.
 */
export const normalizeVoucher = (raw: string): string | null => {
  const compact = raw.trim().toUpperCase().replace(/[ -]/g, '');
  const bare =
    compact.length === PREFIX.length + CODE_LENGTH
      ? compact.slice(PREFIX.length)
      : compact;
  const code = Array.from(bare, char => LOOKALIKES[char] ?? char).join('');

  if (
    code.length !== CODE_LENGTH ||
    Array.from(code).some(char => !ALPHABET.includes(char))
  ) {
    return null;
  }

  const groups = Array.from(
    { length: CODE_LENGTH / GROUP_LENGTH },
    (_, index) => code.slice(index * GROUP_LENGTH, (index + 1) * GROUP_LENGTH),
  );
  return [PREFIX, ...groups].join('-');
};

/**
 * Trim, drop a leading `#`, uppercase; digits alone become `GSSD-<digits>`.
 * Null when the result is not a ticket key.
 */
export const normalizeTicketKey = (raw: string): string | null => {
  const cleaned = raw.trim().replace(/^#/, '').toUpperCase();
  const key = ONLY_DIGITS.test(cleaned)
    ? `${DEFAULT_TICKET_PROJECT}-${cleaned}`
    : cleaned;

  return TICKET_KEY_SHAPE.test(key) ? key : null;
};

const VOUCHER_IN_TEXT = /GSV-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/gi;

/** Every voucher-shaped text in `text` replaced by a mask. */
export const redactVouchers = (text: string): string =>
  text.replace(VOUCHER_IN_TEXT, 'GSV-****-****-****');
