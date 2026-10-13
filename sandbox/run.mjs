#!/usr/bin/env node
// Conductor sandbox CLI.
//
//   node sandbox/run.mjs up [--fresh]            start the isolated daemon, fakes and the real conductor
//   node sandbox/run.mjs iterate [options]       run update iterations and write a report
//        --iterations N    (default 15)
//        --seed N          (default: time based; printed so a run can be replayed)
//        --profiles a,b    only these chaos profiles (default: all non-destructive)
//        --destructive     also run profiles that can leave the conductor down
//   node sandbox/run.mjs status                  containers, versions, chaos state
//   node sandbox/run.mjs down [--purge]          remove the sandbox daemon (and run/ with --purge)

import { env } from './lib/env.mjs';
import { down, up, dindRunning } from './lib/setup.mjs';
import { snapshot, corehub, dockerProxy } from './lib/stack.mjs';
import { backofficeAdmin } from './lib/setup.mjs';
import { iterate } from './lib/iterate.mjs';
import { say } from './lib/util.mjs';

const [, , command = 'help', ...rest] = process.argv;
const flag = name => rest.includes(`--${name}`);
const option = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i !== -1 && rest[i + 1] ? rest[i + 1] : fallback;
};

const status = async () => {
  if (!(await dindRunning())) {
    say('sandbox is not running (node sandbox/run.mjs up)');
    return;
  }
  const snap = await snapshot();
  snap.containers
    .sort((a, b) => a.service.localeCompare(b.service))
    .forEach(c => say(`${c.service.padEnd(40)} ${c.tag.padEnd(12)} ${c.state}${c.health ? `/${c.health}` : ''} restarts=${c.restartCount}`));
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
    case 'iterate':
      await iterate({
        iterations: Number(option('iterations', 15)),
        seed: Number(option('seed', Date.now() % 100000)),
        profiles: option('profiles', '')
          .split(',')
          .filter(Boolean),
        destructive: flag('destructive'),
      });
      break;
    case 'status':
      await status();
      break;
    case 'down':
      await down({ purge: flag('purge') });
      break;
    default:
      process.stdout.write(`usage: node sandbox/run.mjs <up|iterate|status|down>\nsandbox dir: ${env.sandboxDir}\n`);
  }
};

main().catch(e => {
  say(`FAILED: ${e.message}`);
  process.exitCode = 1;
});
