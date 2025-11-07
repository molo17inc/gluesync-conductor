export type ParseImage = (imageString?: string) => Readonly<{
  registry: string;
  repository: string;
  tag: string;
  fullName: string;
  original: string;
  imageName: string;
  shortImageName: string;
}>;
