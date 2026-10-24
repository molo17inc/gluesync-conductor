#!/usr/bin/env node
// Conductor sandbox CLI.
//
//   node sandbox/run.mjs up [--fresh]            start the isolated daemon, fakes and the real conductor
//   node sandbox/run.mjs iterate [options]       run update iterations and write a report
//        --iterations N    (default 15)
//        --seed N          (default: time based; printed so a run can be replayed)
//        --profiles a,b    only these chaos profiles (default: all non-destructive)
//        --profiles all    every non-destructive profile once, minus --exclude / SANDBOX_EXCLUDE_PROFILES
//        --exclude a,b     profiles left out of `all` (added to SANDBOX_EXCLUDE_PROFILES)
//        --shard i/n       only the profiles at positions k with k % n == i-1 (1-based i); implies --profiles all
//        --destructive     also run profiles that can leave the conductor down
//      exits 1 if any iteration FAILs (WARN does not); writes reports/<run>/junit.xml
//   node sandbox/run.mjs enospc                  real-kernel ENOSPC test of safeWriteFile on a 64 KiB tmpfs (needs the sandbox up)
//   node sandbox/run.mjs status                  containers, versions, chaos state
//   node sandbox/run.mjs down [--purge]          remove the sandbox daemon (and run/ with --purge)

import { env } from './lib/env.mjs';
import { backofficeAdmin, down, up, dindRunning } from './lib/setup.mjs';
import { snapshot, corehub, dockerProxy } from './lib/stack.mjs';
import { iterate } from './lib/iterate.mjs';
import { enospc } from './lib/enospc.mjs';
import { describeState, say } from './lib/util.mjs';

// The kit's directories are bind-mounted into containers that run as other users (the fakes run
// as `node`): on a Linux host a 0755 directory created here would be read-only for them.
process.umask(0);

const [, , command = 'help', ...rest] = process.argv;
const flag = name => rest.includes(`--${name}`);
const option = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i !== -1 && rest[i + 1] ? rest[i + 1] : fallback;
};

const list = value => (value || '').split(',').filter(Boolean);

const status = async () => {
  if (!(await dindRunning())) {
    say('sandbox is not running (node sandbox/run.mjs up)');
    return;
  }
  const snap = await snapshot();
  snap.containers
    .sort((a, b) => a.service.localeCompare(b.service))
    .forEach(c => say(`${c.service.padEnd(40)} ${c.tag.padEnd(12)} ${describeState(c)} restarts=${c.restartCount}`));
  if (snap.strays.length) say('stray containers', snap.strays);
  say('fake corehub', (await corehub.admin('/__sandbox/state')).json);
  say('backoffice', (await backofficeAdmin('/__sandbox/state')).json);
  say('docker proxy', (await dockerProxy()).json);
};

const main = async () => {
  switch (command) {
    case 'up':
      await up({ fresh: flag('fresh') });
      break;
    case 'iterate': {
      const run = await iterate({
        iterations: Number(option('iterations', 15)),
        seed: Number(option('seed', Date.now() % 100000)),
        profiles: list(option('profiles', '')),
        destructive: flag('destructive'),
        shard: option('shard', ''),
        exclude: [...list(process.env.SANDBOX_EXCLUDE_PROFILES), ...list(option('exclude', ''))],
      });
      const failed = run.iterations.filter(it => it.outcome === 'fail');
      if (failed.length) {
        say(`FAILED: ${failed.length} of ${run.iterations.length} iteration(s): ${failed.map(it => it.profile).join(', ')}`);
        process.exitCode = 1;
      }
      break;
    }
    case 'enospc':
      await enospc();
      break;
    case 'status':
      await status();
      break;
    case 'down':
      await down({ purge: flag('purge') });
      break;
    default:
      process.stdout.write(`usage: node sandbox/run.mjs <up|iterate|enospc|status|down>\nsandbox dir: ${env.sandboxDir}\n`);
  }
};

try {
  await main();
} catch (e) {
  say(`FAILED: ${e.message}`);
  process.exitCode = 1;
}
