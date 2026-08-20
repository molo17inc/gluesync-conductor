export type LegacyUpdateEnvResponse = Readonly<{
  success: true;
  data: {
    enabled: boolean;
  };
}>;

export type LegacyUpdateEnvErrorResponse = Readonly<{
  success: false;
  error: string;
  details?: string;
}>;

export type SetLegacyUpdateEnvBody = Readonly<{
  enabled: boolean;
}>;
