import { CompareImageTags, ParsedTag, TagOrder } from './imageTagOrder.model';

// A release part is a small number; a commit is anything else, even when it
// happens to hold digits only (`2.3.2.0.1234567`)
const RELEASE_PART = /^\d{1,5}$/;
// An abbreviated git commit: at least 7 hex digits
const BUILD_PART = /^[0-9a-f]{7,40}$/i;

/**
 * `2.3.1.4` is a release, `2.3.2.0.4dbdd8aa7e` a beta/alpha build of 2.3.2.0.
 * An image variant suffix (`2.3.1.4-debian`) names the same version. Anything
 * else (`latest`, `v3.1`, `2.3.x`) is not a version: undefined.
 */
export const parseTag = (tag: string): ParsedTag | undefined => {
  const parts = tag.trim().split('-')[0].split('.');
  const releaseLength = parts.findIndex(part => !RELEASE_PART.test(part));
  const release = (
    releaseLength === -1 ? parts : parts.slice(0, releaseLength)
  ).map(Number);
  const rest = releaseLength === -1 ? [] : parts.slice(releaseLength);

  if (release.length < 2 || rest.length > 1) {
    return undefined;
  }

  if (rest.length === 1 && !BUILD_PART.test(rest[0])) {
    return undefined;
  }

  return rest.length === 1 ? { release, build: rest[0] } : { release };
};

// Missing parts count as zero: 2.3 is 2.3.0.0
const compareReleases = (
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>,
): number => {
  const length = Math.max(a.length, b.length);
  const diff = Array.from(
    { length },
    (_, index) => (a[index] ?? 0) - (b[index] ?? 0),
  ).find(value => value !== 0);

  return diff ?? 0;
};

const fromSign = (value: number): TagOrder => {
  if (value < 0) {
    return 'older';
  }
  return value > 0 ? 'newer' : 'equal';
};

/**
 * Orders two image tags the way Gluesync numbers its images. A build
 * `X.<commit>` comes before the release X it leads to, so 2.3.2.0.4dbdd8aa7e
 * is older than 2.3.2.0 and newer than 2.3.1.4.
 */
const compareImageTags: CompareImageTags = (a, b) => {
  const left = parseTag(a);
  const right = parseTag(b);

  if (!left || !right) {
    return 'unknown';
  }

  const byRelease = compareReleases(left.release, right.release);

  if (byRelease !== 0) {
    return fromSign(byRelease);
  }

  if (left.build === right.build) {
    return 'equal';
  }

  if (left.build && right.build) {
    return 'unknown';
  }

  // Same release, only one of them a build: the build is the older
  return left.build ? 'older' : 'newer';
};

export default compareImageTags;
