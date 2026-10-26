export type ParseImageResult = Readonly<{
  registry: string;
  repository: string;
  tag: string;
  // The tag is a Compose interpolation (`${TAG:-2.3.0}`): `tag` is then empty
  interpolatedTag: boolean;
  // `sha256:...` of a pinned image, empty otherwise
  digest: string;
  fullName: string;
  original: string;
  imageName: string;
  shortImageName: string;
}>;

export type ParseImage = (imageString?: string) => ParseImageResult;
