#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import esbuild from 'esbuild';

const DEFAULT_ENTRY_POINT = './src/index.ts';
const DEFAULT_OUTFILE_NAME = 'index.js';

const entryPointFilePath = process.argv[2] || DEFAULT_ENTRY_POINT;
const outFileName = process.argv[3] || DEFAULT_OUTFILE_NAME;

const outdir = 'build';
const outfile = path.join(outdir, outFileName);

const build = async (
  entryPoint = DEFAULT_ENTRY_POINT,
  outfileName = DEFAULT_OUTFILE_NAME,
) => {
  try {
    if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });

    process.stdout.write(
      `Building functions...${entryPoint !== DEFAULT_ENTRY_POINT ? ` [${entryPoint}]` : ''}\n`,
    );

    await esbuild.build({
      write: true,
      entryPoints: [entryPoint],
      platform: 'node',
      format: 'esm',
      target: 'node22.13.1',
      minify: true,
      sourcemap: true,
      bundle: true,
      packages: 'external', // ← AGGIUNGI QUESTO
      external: ['node:*'], // ← AGGIUNGI QUESTO
      resolveExtensions: ['.ts', '.tsx', '.js', '.jsx'], // ← AGGIUNGI QUESTO
      bundle: true,
      outfile: path.join('build', outfileName),
    });

    process.stdout.write('Done.\n');
  } catch (error) {
    process.stderr.write(`Error!\n${error.stack || error}\n`);
    process.exitCode = 1;
  }
};

build(entryPointFilePath, outFileName);
