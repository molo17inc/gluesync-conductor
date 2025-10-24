export type OptionsType = {
  filename?: string;
  basePath?: string;
};

export type GetRootPath = (options?: Readonly<OptionsType>) => string;
