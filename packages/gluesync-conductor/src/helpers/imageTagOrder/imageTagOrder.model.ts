/**
 * How one image tag stands against another: `older` means the first tag is a
 * lower version than the second. `unknown` when either is not a version
 * (`latest`, `v3.1`, empty) or when they are two builds of one release, whose
 * commits tell nothing about which is newer.
 */
export type TagOrder = 'older' | 'equal' | 'newer' | 'unknown';

export type ParsedTag = Readonly<{
  // Numeric release parts: `2.3.1.4` -> [2, 3, 1, 4]
  release: ReadonlyArray<number>;
  // Commit of a beta/alpha build (`2.3.2.0.4dbdd8aa7e`), undefined for a release
  build?: string;
}>;

export type CompareImageTags = (a: string, b: string) => TagOrder;
