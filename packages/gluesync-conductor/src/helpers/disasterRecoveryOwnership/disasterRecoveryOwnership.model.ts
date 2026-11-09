import type Docker from 'dockerode';

import type { RawComposeFile } from '../../models/composeFile.model';
import type { DisasterRecoveryTargets } from '../disasterRecoveryCompose/disasterRecoveryCompose.model';

/** The user Core Hub runs as. */
export type CoreHubOwner = Readonly<{ uid: number; gid: number }>;

/**
 * Makes the data directory of Chronos belong to the user Core Hub runs as,
 * recursively. Core Hub must write there (the Litestream meta directory, and the
 * `scheduler.db` it installs on promotion); Chronos runs as root and works
 * whatever the owner. Throws when it cannot, naming why. Not undone by a disable.
 */
export type GiveChronosDataToCoreHub = (
  docker: Readonly<Docker>,
  compose: Readonly<Partial<RawComposeFile>>,
  targets: DisasterRecoveryTargets,
) => Promise<void>;

/** `Config.User` of the Core Hub image, else the default of the image (1017). */
export type ResolveCoreHubOwner = (
  docker: Readonly<Docker>,
  image: string | undefined,
) => Promise<CoreHubOwner>;
