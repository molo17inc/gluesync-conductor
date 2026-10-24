// Bundles safeWriteFile.ts (and its imports) into one CJS file with the esbuild the
// repo already uses for the conductor build (@gluesync/scripts' buildService).
// Run through `yarn node` (Yarn PnP). esbuild is resolved as buildService.js resolves
// it, i.e. from the @gluesync/scripts workspace, since the sandbox does not declare it:
//   yarn node enospcBundle.cjs <repoDir> <entry.ts> <outfile.cjs>
const path = require('node:path');
const { createRequire } = require('node:module');

const [repoDir, entry, outfile] = process.argv.slice(2);
const esbuild = createRequire(path.join(repoDir, 'packages', 'scripts', 'lib', 'buildService.js'))('esbuild');

esbuild
  .build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    minify: false,
    logLevel: 'warning',
  })
  .catch(e => {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  });
