/* eslint-disable functional/immutable-data, functional/no-let -- sets process.env and files for a test */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV_NAMES = ['DKR_COMPOSE_FILE', 'PROJECT_CWD'];

/**
 * A temp folder with a compose file the conductor treats as its own (the
 * environment points at it). Call `restore` when the test is over.
 */
const makeComposeSandbox = () => {
  const saved = new Map(ENV_NAMES.map(name => [name, process.env[name]]));
  const dir = mkdtempSync(join(tmpdir(), 'compose-'));
  const compose = join(dir, 'docker-compose.yml');

  Reflect.deleteProperty(process.env, 'PROJECT_CWD');
  process.env.DKR_COMPOSE_FILE = compose;

  return {
    dir,
    compose,
    setCompose: (text: string): void => writeFileSync(compose, text),
    read: (path: string): string => readFileSync(path, 'utf8'),
    restore: (): void =>
      saved.forEach((value, name) => {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }),
  };
};

export default makeComposeSandbox;
