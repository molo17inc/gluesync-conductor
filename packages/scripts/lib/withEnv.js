#!/usr/bin/env node

/* eslint-disable functional/immutable-data */

import { resolve } from 'path';
import fs from 'fs';
import { spawn, execSync } from 'child_process';
import * as dotenv from 'dotenv';

const baseEnvFile = './environments/.env';

const {
  env: { ENV: env = 'dev' },
} = process;

const [, , ...args] = process.argv;

const getCommitHash = () => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch (e) {
    return undefined;
  }
};

const commitHash = getCommitHash();

const envFlagIndex = args.findIndex(a => a === '--with-env');

const envCommand = envFlagIndex > -1 ? args[envFlagIndex + 1] : null;

const command = (
  envCommand
    ? [...args.slice(0, envFlagIndex), ...args.slice(envFlagIndex + 2)]
    : args
).join(' ');

const envName = envCommand || env;

const envFile = resolve(
  process.cwd().split('myo-platform')[0],
  'myo-platform',
  envName ? `${baseEnvFile}.${envName}` : baseEnvFile,
);

console.log(`Loading '${envFile}' ...`);

const localEnvConfig = fs.existsSync(`${envFile}.local`)
  ? dotenv.parse(fs.readFileSync(`${envFile}.local`))
  : null;

if (!fs.existsSync(envFile)) {
  // eslint-disable-next-line functional/no-throw-statements
  throw new Error(`Dotenv file not found: ${envFile}`);
}

dotenv.config({
  path: envFile,
});

if (localEnvConfig !== null) {
  console.log(`Setting COMMIT_HASH='${commitHash}'.`);
  process.env.COMMIT_HASH = commitHash;

  console.log(`Found local .env file, loading '${envFile}.local' ...`);
  // Update env variables using .env local file
  Object.entries(localEnvConfig).forEach(([key, value]) => {
    process.env[key] = value;
  });
}

console.log('command: ', command);

spawn(command, {
  shell: true,
  stdio: 'inherit',
});
