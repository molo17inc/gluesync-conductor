import type Docker from 'dockerode';
import { PinnedImage } from '../../pinRunningImages/pinRunningImages.model';

export type ReconcileRunningImages = (
  docker: Readonly<Docker>,
) => Promise<ReadonlyArray<PinnedImage>>;
