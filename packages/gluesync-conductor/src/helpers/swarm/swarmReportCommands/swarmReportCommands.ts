import { SwarmReportCommands } from './swarmReportCommands.model';

// What `docker ps` of one node cannot tell about the stack: where each task
// runs, why the failed ones stopped (`--no-trunc` keeps the error), and the
// state of the nodes themselves.
const swarmReportCommands: SwarmReportCommands = namespace => [
  { cmd: 'docker', args: ['service', 'ls'] },
  { cmd: 'docker', args: ['stack', 'ps', namespace, '--no-trunc'] },
  { cmd: 'docker', args: ['node', 'ls'] },
];

export default swarmReportCommands;
