import semver from 'semver';

import { ConductorUpdateRefusal } from './conductorUpdateRefusal.model';

const conductorUpdateRefusal: ConductorUpdateRefusal = (running, target) => {
  // `0.14.0-alpine` runs 0.14.0, the suffix names a variant of the image
  const runningVersion = (running ?? '').split('-')[0];

  if (target && target === runningVersion) {
    return null;
  }

  if (!semver.valid(runningVersion)) {
    return `Conductor not updated: the running version "${running ?? ''}" is not a release version, so ${target ?? 'the latest release'} could be older than it and would drop Swarm support`;
  }

  if (!target || !semver.valid(target)) {
    return `Conductor not updated: the latest release "${target ?? ''}" is not a valid version to compare with the running ${runningVersion}`;
  }

  return semver.gt(target, runningVersion)
    ? null
    : `Conductor not updated: ${target} is not newer than the running ${runningVersion}, and an older Conductor would drop Swarm support`;
};

export default conductorUpdateRefusal;
