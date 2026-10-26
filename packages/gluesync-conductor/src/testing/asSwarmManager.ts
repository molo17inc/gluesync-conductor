import type Docker from 'dockerode';

/**
 * Adds to a fake swarm docker what `getOrchestrator` asks of the daemon, so
 * the real detection answers swarm (with CONDUCTOR_ORCHESTRATOR=swarm and
 * SWARM_STACK_NAMESPACE set by the spec).
 */
const asSwarmManager = (docker: Readonly<Docker>): Docker =>
  ({
    ...docker,
    getContainer: () => ({
      inspect: async () => ({ Config: { Labels: {} } }),
    }),
    info: async () => ({ Swarm: { ControlAvailable: true } }),
    ping: async () => 'OK',
  }) as unknown as Docker;

export default asSwarmManager;
