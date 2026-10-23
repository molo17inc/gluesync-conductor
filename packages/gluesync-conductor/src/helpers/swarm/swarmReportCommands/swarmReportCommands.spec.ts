import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import swarmReportCommands from './swarmReportCommands';

describe('swarmReportCommands', () => {
  it('lists the services, the tasks of the stack and the nodes', () => {
    assert.deepEqual(swarmReportCommands('gluesync'), [
      { cmd: 'docker', args: ['service', 'ls'] },
      { cmd: 'docker', args: ['stack', 'ps', 'gluesync', '--no-trunc'] },
      { cmd: 'docker', args: ['node', 'ls'] },
    ]);
  });
});
