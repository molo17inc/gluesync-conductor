#!/usr/bin/env node

import path from 'path';
import esbuild from 'esbuild';
import { copy } from 'esbuild-plugin-copy';
import { createRequire } from 'module';

const DEFAULT_ENTRY_POINT = './src/index.ts';
const DEFAULT_OUTFILE_NAME = 'index.js';

const entryPointFilePath = process.argv[2];
const outFileName = process.argv[3];

const build = async (
  entryPoint = DEFAULT_ENTRY_POINT,
  outfileName = DEFAULT_OUTFILE_NAME,
) => {
  try {
    process.stdout.write(
      `Building functions...${
        entryPoint !== DEFAULT_ENTRY_POINT ? ` [${entryPoint}]` : ''
      }\n`,
    );

    // Resolve the swagger-ui static path from Yarn PnP
    const require = createRequire(import.meta.url);

    // Resolve the path to the package.json of @fastify/swagger-ui
    const swaggerUiPackagePath = require.resolve(
      '@fastify/swagger-ui/package.json',
    );

    // Get the directory of the package
    const swaggerUiDir = path.dirname(swaggerUiPackagePath);

    // Construct the path to the static assets
    const swaggerUiStatic = path.join(swaggerUiDir, 'static');

    await esbuild.build({
      write: true,
      entryPoints: [entryPoint],
      platform: 'node',
      format: 'cjs',
      target: 'node24.16.0',
      loader: { '.json': 'json' },
      minify: true,
      sourcemap: true,
      bundle: true,
      external: ['*.node'],
      outfile: path.join('build', outfileName),
      plugins: [
        copy({
          resolveFrom: 'cwd',
          assets: [
            {
              from: '../gluesync-logs-uploader/collect-logs.ps1',
              to: 'build/collect-logs.ps1',
            },
            {
              from: '../gluesync-logs-uploader/collect-logs.sh',
              to: 'build/collect-logs.sh',
            },
            {
              from: '../gluesync-logs-uploader/system-info.sh',
              to: 'build/system-info.sh',
            },
            {
              from: '../gluesync-logs-uploader/system-info.ps1',
              to: 'build/system-info.ps1',
            },
            {
              from: '../gluesync-logs-uploader/copy-agent-data.sh',
              to: 'build/copy-agent-data.sh',
            },
            {
              from: '../gluesync-logs-uploader/copy-agent-data.ps1',
              to: 'build/copy-agent-data.ps1',
            },
            {
              from: `${swaggerUiStatic}/**/*`,
              to: 'build/static',
            },
          ],
        }),
      ],
    });

    process.stdout.write('Done.\n');
  } catch (error) {
    process.stderr.write(`Error!\n${error.stack || error}\n`);
  }
};

build(entryPointFilePath, outFileName);
