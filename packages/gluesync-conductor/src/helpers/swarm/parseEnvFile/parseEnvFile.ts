import { ParseEnvFile } from './parseEnvFile.model';

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

// Split on the first `=` instead of one regex over the whole line: a pattern
// with `\s*` and `.*` around it backtracks badly on a long run of spaces.
const parseAssignment = (
  line: string,
): readonly [key: string, raw: string] | undefined => {
  const separator = line.indexOf('=');

  if (separator < 0) {
    return undefined;
  }

  const left = line.slice(0, separator).trimEnd();
  const key = /^export\s/.test(left)
    ? left.slice('export'.length).trim()
    : left;

  return KEY.test(key) ? [key, line.slice(separator + 1)] : undefined;
};

const unquote = (raw: string): string => {
  const value = raw.trim();
  const quote = value[0];

  if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
    return value.slice(1, value.lastIndexOf(quote));
  }

  // An unquoted value ends at a ` #` comment
  const comment = value.search(/\s#/);

  return (comment < 0 ? value : value.slice(0, comment)).trim();
};

/**
 * `KEY=VALUE` lines of a `.env` file. Blank lines and `#` comments are
 * skipped, one pair of surrounding quotes is removed. No `${VAR}` expansion:
 * `docker stack deploy` does that itself, from the environment it is given.
 */
const parseEnvFile: ParseEnvFile = content =>
  Object.fromEntries(
    content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .flatMap(line => {
        const assignment = parseAssignment(line);

        return assignment
          ? [[assignment[0], unquote(assignment[1])] as const]
          : [];
      }),
  );

export default parseEnvFile;
