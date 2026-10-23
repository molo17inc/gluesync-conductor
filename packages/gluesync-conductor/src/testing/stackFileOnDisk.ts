/* eslint-disable functional/immutable-data -- sets and restores the environment readComposeFile reads at load time */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import { readComposeFile } from '../helpers/composeFile/readComposeFile/readComposeFile';
import loadWithStubs from './loadWithStubs';
import { labStackYaml } from './labStack';

type Reader = Readonly<{ readComposeFile: typeof readComposeFile }>;

/**
 * The lab stack file written to a temp folder and read the way the kit does:
 * `DKR_COMPOSE_FILE` is an absolute path and PROJECT_CWD is not set (Yarn sets
 * it, and getRootPath would prefix it). Answers a `readComposeFile` bound to
 * it, to stub into the subject under test, and a `cleanup`.
 */
const stackFileOnDisk = async (yaml: string = labStackYaml) => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-stack-'));
  const file = join(dir, 'docker-stack.yml');

  await writeFile(file, yaml, 'utf8');

  const saved = {
    file: process.env.DKR_COMPOSE_FILE,
    cwd: process.env.PROJECT_CWD,
  };

  process.env.DKR_COMPOSE_FILE = file;
  delete process.env.PROJECT_CWD;

  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };

  try {
    const reader = loadWithStubs<Reader>(
      path.resolve(
        __dirname,
        '../helpers/composeFile/readComposeFile/readComposeFile',
      ),
      {},
    );

    return {
      file,
      readComposeFile: reader.readComposeFile,
      // PROJECT_CWD is read on every read, so it stays unset until here
      cleanup: async () => {
        restore('PROJECT_CWD', saved.cwd);
        await rm(dir, { recursive: true, force: true });
      },
    };
  } finally {
    restore('DKR_COMPOSE_FILE', saved.file);
  }
};

export default stackFileOnDisk;
