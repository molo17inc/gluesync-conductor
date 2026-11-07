import type Docker from 'dockerode';

/** A service whose compose file names an older tag than its container runs. */
export type PinnedImage = Readonly<{
  service: string;
  coreHub: boolean;
  // What the compose file said, and what it says now (the running tag)
  composeImage: string;
  runningImage: string;
}>;

export type PinRunningImages = (
  docker: Readonly<Docker>,
) => Promise<ReadonlyArray<PinnedImage>>;
