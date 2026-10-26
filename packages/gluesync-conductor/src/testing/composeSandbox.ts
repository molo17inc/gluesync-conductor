/* eslint-disable functional/immutable-data, functional/no-let -- sets process.env and files for a test */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const COMPOSE = `# kit header
services:
  gluesync-core-hub:
    image: molo17/gluesync-core-hub:2.3.0.0
    labels:
      - com.molo17.conductor.type=core-hub
  gluesync-conductor:
    image: molo17/gluesync-conductor:0.13.1
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost"]
`;

// Cut inside the flow sequence, as a write that died half way would.
export const TRUNCATED = COMPOSE.slice(0, COMPOSE.indexOf('"curl"') + 3);

export const CORRUPT_SHAPES: ReadonlyArray<Readonly<[string, string]>> = [
  ['empty', ''],
  ['whitespace', '\n  \n'],
  ['null', 'null'],
  ['a list', '[]'],
  ['truncated YAML', TRUNCATED],
  ['empty services', 'services: {}\n'],
  ['no services key', 'name: gluesync\n'],
];

const ENV_NAMES = [
  'DKR_COMPOSE_FILE',
  'CONDUCTOR_COMPOSE_BACKUP_DIR',
  'PROJECT_CWD',
  'CONDUCTOR_NAME',
];

/**
 * A temp folder with a compose file the conductor treats as its own (the
 * environment points at it) and a backup folder of its own. Call `restore`
 * in afterEach.
 */
export const makeComposeSandbox = () => {
  const saved = new Map(ENV_NAMES.map(name => [name, process.env[name]]));
  const dir = mkdtempSync(join(tmpdir(), 'compose-'));
  const compose = join(dir, 'docker-compose.yml');
  const backupDir = join(dir, '.conductor');
  const lastGood = join(backupDir, 'docker-compose.last-good.yml');

  Reflect.deleteProperty(process.env, 'PROJECT_CWD');
  process.env.DKR_COMPOSE_FILE = compose;
  process.env.CONDUCTOR_COMPOSE_BACKUP_DIR = backupDir;

  return {
    dir,
    compose,
    lastGood,
    setCompose: (text: string): void => writeFileSync(compose, text),
    setLastGood: (text: string): void => {
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(lastGood, text);
    },
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
