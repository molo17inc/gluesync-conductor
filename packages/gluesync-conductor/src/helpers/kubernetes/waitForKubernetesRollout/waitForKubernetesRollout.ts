import {
  KubernetesClient,
  KubernetesPod,
  KubernetesWorkload,
} from '../kubernetes.model';
import listKubernetesWorkloads from '../listKubernetesWorkloads/listKubernetesWorkloads';

export type RolloutClock = Readonly<{
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}>;

export const realRolloutClock: RolloutClock = {
  now: () => Date.now(),
  sleep: ms =>
    new Promise(resolve => {
      setTimeout(resolve, ms);
    }),
};

export type RolloutOptions = Readonly<{
  // How long the rollout may take before it counts as failed
  timeoutMs: number;
  // How long the workload must stay ready once every pod runs the new template
  stabilityMs: number;
  pollMs?: number;
  clock?: RolloutClock;
}>;

// A pod of the new template that will not get further by waiting
const DEAD_END_REASONS: ReadonlySet<string> = new Set([
  'ErrImagePull',
  'ImagePullBackOff',
  'InvalidImageName',
  'ErrImageNeverPull',
  'CrashLoopBackOff',
  'CreateContainerConfigError',
]);

// A registry that is slow to answer is given this long before a pull error counts
const DEAD_END_GRACE_MS = 30_000;

const envSeconds = (name: string, fallbackSeconds: number): number => {
  const raw = Number(process.env[name]);

  return (Number.isFinite(raw) && raw >= 0 ? raw : fallbackSeconds) * 1000;
};

/** KUBERNETES_ROLLOUT_TIMEOUT_SECONDS (600) and KUBERNETES_STABILITY_SECONDS (20). */
export const rolloutOptionsFromEnv = (): RolloutOptions => ({
  timeoutMs: envSeconds('KUBERNETES_ROLLOUT_TIMEOUT_SECONDS', 600) || 600_000,
  stabilityMs: envSeconds('KUBERNETES_STABILITY_SECONDS', 20),
});

/** Every pod runs the template of the workload and is ready, and no old pod is left. */
export const isRolledOut = (workload: Readonly<KubernetesWorkload>): boolean =>
  workload.observed &&
  workload.updatedReplicas >= workload.desiredReplicas &&
  workload.readyReplicas >= workload.desiredReplicas &&
  workload.replicas === workload.desiredReplicas;

const waitingOf = (
  pod: Readonly<KubernetesPod>,
): Readonly<{ reason?: string; message?: string }> | undefined =>
  pod.status?.containerStatuses?.find(status => status.state?.waiting)?.state
    ?.waiting;

// Only the pods of the image being rolled out: an old pod that crash-loops is
// what the update is replacing
const deadEndOf = (
  workload: Readonly<KubernetesWorkload>,
  image: string | undefined,
): string | undefined => {
  const stuck = workload.pods
    .filter(
      pod =>
        !pod.metadata.deletionTimestamp &&
        (image === undefined || pod.spec?.containers?.[0]?.image === image),
    )
    .map(waitingOf)
    .find(waiting => waiting?.reason && DEAD_END_REASONS.has(waiting.reason));

  return stuck
    ? [stuck.reason, stuck.message].filter(Boolean).join(': ')
    : undefined;
};

const describe = (workload: Readonly<KubernetesWorkload>): string =>
  `${workload.readyReplicas} of ${workload.desiredReplicas} ready, ${workload.updatedReplicas} on the new version`;

export type RolloutResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: string }>;

/**
 * Waits until the workload `name` runs its current template on every pod and
 * stays ready for the stability window. `image`, when given, is the image
 * being rolled out: a pod of it that cannot pull or crash-loops ends the wait
 * early. Never throws for a rollout that fails; an API error rejects.
 */
const waitForKubernetesRollout = async (
  client: KubernetesClient,
  name: string,
  {
    timeoutMs,
    stabilityMs,
    pollMs = 3000,
    clock = realRolloutClock,
  }: RolloutOptions,
  image?: string,
): Promise<RolloutResult> => {
  const startedAt = clock.now();

  const read = async (): Promise<KubernetesWorkload | undefined> =>
    (await listKubernetesWorkloads(client)).find(
      workload => workload.name === name,
    );

  const poll = async (): Promise<RolloutResult> => {
    const workload = await read();

    if (!workload) {
      return { ok: false, reason: `${name} is no longer in the namespace` };
    }

    const elapsed = clock.now() - startedAt;

    if (isRolledOut(workload)) {
      await clock.sleep(stabilityMs);

      const later = stabilityMs > 0 ? await read() : workload;

      if (later && isRolledOut(later)) {
        return { ok: true };
      }
    }

    const deadEnd = deadEndOf(workload, image);

    if (deadEnd && elapsed >= DEAD_END_GRACE_MS) {
      return { ok: false, reason: deadEnd };
    }

    if (clock.now() - startedAt >= timeoutMs) {
      return {
        ok: false,
        reason: `not ready after ${Math.round(timeoutMs / 1000)} s (${describe(workload)})${deadEnd ? `: ${deadEnd}` : ''}`,
      };
    }

    await clock.sleep(pollMs);

    return poll();
  };

  return poll();
};

export default waitForKubernetesRollout;
