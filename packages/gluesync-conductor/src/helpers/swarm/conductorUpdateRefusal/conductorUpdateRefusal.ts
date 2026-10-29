import semver from 'semver';

import { ConductorUpdateRefusal } from './conductorUpdateRefusal.model';

// Alpha builds are tagged `X.Y.Z.<commit>` (`0.14.0.814e5b87`)
const ALPHA_BUILD = /^(\d+\.\d+\.\d+)\.([0-9A-Za-z]+)$/;

/**
 * The version as semver: an alpha build `X.Y.Z.<commit>` is a prerelease of
 * X.Y.Z, so the release X.Y.Z is newer than it. The `b` keeps a commit made
 * of digits only a valid prerelease identifier (no leading zero rule).
 */
const toSemver = (version: string): string | null => {
  const alpha = ALPHA_BUILD.exec(version);

  return semver.valid(alpha ? `${alpha[1]}-b${alpha[2]}` : version);
};

const alphaBase = (version: string): string | undefined =>
  ALPHA_BUILD.exec(version)?.[1];

const conductorUpdateRefusal: ConductorUpdateRefusal = (running, target) => {
  // `0.14.0-alpine` runs 0.14.0, the suffix names a variant of the image
  const runningVersion = (running ?? '').split('-')[0];

  if (target && target === runningVersion) {
    return null;
  }

  const runningSemver = toSemver(runningVersion);

  if (!runningSemver) {
    return `Conductor not updated: the running version "${running ?? ''}" is not a release version, so ${target ?? 'the latest release'} could be older than it and would drop Swarm support`;
  }

  const targetSemver = target ? toSemver(target) : null;

  if (!target || !targetSemver) {
    return `Conductor not updated: the latest release "${target ?? ''}" is not a valid version to compare with the running ${runningVersion}`;
  }

  // Two alpha builds of one version: the commits tell nothing about which is newer
  const base = alphaBase(runningVersion);

  if (base && base === alphaBase(target)) {
    return `Conductor not updated: ${target} and the running ${runningVersion} are both alpha builds of ${base}, which one is newer cannot be told`;
  }

  return semver.gt(targetSemver, runningSemver)
    ? null
    : `Conductor not updated: ${target} is not newer than the running ${runningVersion}, and an older Conductor would drop Swarm support`;
};

export default conductorUpdateRefusal;
