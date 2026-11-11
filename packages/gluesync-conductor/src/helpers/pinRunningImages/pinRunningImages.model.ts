import type Docker from 'dockerode';
import { TagOrder } from '../imageTagOrder/imageTagOrder.model';

/** A service whose compose file names another tag than its container runs. */
export type PinnedImage = Readonly<{
  service: string;
  coreHub: boolean;
  // What the compose file said, and what it says now (the running tag)
  composeImage: string;
  runningImage: string;
  // The compose tag against the running one: `older` would have downgraded
  composeIs: TagOrder;
}>;

export type PinRunningImages = (
  docker: Readonly<Docker>,
) => Promise<ReadonlyArray<PinnedImage>>;
