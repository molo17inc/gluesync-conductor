import { ParseEnvFile } from './parseEnvFile.model';

const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;

const unquote = (raw: string): string => {
  const value = raw.trim();
  const quote = value[0];

  if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
    return value.slice(1, value.lastIndexOf(quote));
  }

  // An unquoted value ends at a ` #` comment
  return value.replace(/\s+#.*$/, '').trim();
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
        const match = ASSIGNMENT.exec(line);

        return match ? [[match[1], unquote(match[2])] as const] : [];
      }),
  );

export default parseEnvFile;
