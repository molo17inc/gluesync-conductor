#!/usr/bin/env node

import path from 'path';
import esbuild from 'esbuild';
import { copy } from 'esbuild-plugin-copy';

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
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const swaggerUiPackage = require.resolve(
      '@fastify/swagger-ui/package.json',
    );
    const swaggerUiStatic = path.join(path.dirname(swaggerUiPackage), 'static');

    await esbuild.build({
      write: true,
      entryPoints: [entryPoint],
      platform: 'node',
      format: 'cjs',
      target: 'node22.13.1',
      minify: true,
      sourcemap: true,
      bundle: true,
      external: ['*.node'],
      outfile: path.join('build', outfileName),
      plugins: [
        copy({
          resolveFrom: 'cwd',
          assets: {
            from: [`${swaggerUiStatic}/**/*`],
            to: ['build/static'],
          },
        }),
      ],
    });

    process.stdout.write('Done.\n');
  } catch (error) {
    process.stderr.write(`Error!\n${error.stack || error}\n`);
  }
};

build(entryPointFilePath, outFileName);
