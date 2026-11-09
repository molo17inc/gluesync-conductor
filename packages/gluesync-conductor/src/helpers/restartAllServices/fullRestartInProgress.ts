import type Docker from 'dockerode';
import { LabelPrefix } from '../../models/composeFile.model';

/** Put on the helper container of a full stack restart (`docker run --label`). */
export const FULL_RESTART_HELPER_LABEL = `${LabelPrefix.CONDUCTOR}.helper=full-stack-restart`;

// The full stack restart this conductor started, from the request until its
// helper container is done (Linux) or started (Windows, detached). The helper
// outlives the conductor it recreates: `helperStartedAt` covers that part.
const local = new Map<'since', string>();

/** Marks a full stack restart as started; returns the function that ends it. */
export const beginFullRestart = (): (() => void) => {
  local.set('since', new Date().toISOString());
  return () => {
    local.delete('since');
  };
};

/**
 * When the helper of a running full stack restart was created, if any. A
 * failed lookup reads as none: the engine not answering would fail the
 * restart anyway.
 */
const helperStartedAt = async (
  docker: Readonly<Docker>,
): Promise<string | undefined> => {
  try {
    const helpers = await docker.listContainers({
      filters: { label: [FULL_RESTART_HELPER_LABEL] },
    });
    const created = helpers.map(helper => helper.Created).sort()[0];
    return created === undefined
      ? undefined
      : new Date(created * 1000).toISOString();
  } catch {
    return undefined;
  }
};

/**
 * Since when a full stack restart has been running, or undefined. Two at once
 * run `compose down` and `up` against each other (2026-11-07: a second
 * request 28 s after the first started a second helper).
 */
export const fullRestartRunningSince = async (
  docker: Readonly<Docker>,
): Promise<string | undefined> => local.get('since') ?? helperStartedAt(docker);
