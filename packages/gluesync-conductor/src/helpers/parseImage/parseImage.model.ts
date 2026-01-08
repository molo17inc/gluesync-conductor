export type ParseImageResult = Readonly<{
  registry: string;
  repository: string;
  tag: string;
  fullName: string;
  original: string;
  imageName: string;
  shortImageName: string;
}>;

export type ParseImage = (imageString?: string) => ParseImageResult;
