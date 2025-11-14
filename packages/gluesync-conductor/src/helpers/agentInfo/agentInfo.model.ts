export type SupportedEnvironmentVariable = {
  key: string;
  displayName: string;
  type: string;
  default: string;
  isOptional: boolean;
  possibleValues: string[];
};

export type AgentInfo = {
  availableAlpha: boolean;
  availableBeta: boolean;
  availableGA: boolean;
  commercialName: string;
  databaseMinimumSupportedVersion: string;
  databaseName: string;
  databaseSupportedTechnology: string;
  dockerHubRepoName: string;
  documentationPath: string | null;
  glyphLink: string;
  id: number;
  imagePath: string | null;
  internalDocIntroFileName: string;
  internalDocSourceFileName: string;
  internalDocTargetFileName: string;
  internalName: string;
  isSource: boolean;
  isTarget: boolean;
  latestVersionAlpha: string;
  latestVersionBeta: string;
  latestVersionGA: string;
  logoLink: string;
  longDescription: string | null;
  moduleType: string;
  requirements: string;
  shortDescription: string;
  supportedEnvironmentVariables: SupportedEnvironmentVariable[];
  type: string;
};

export type AgentVersionInfo = {
  availableAlpha: boolean;
  availableBeta: boolean;
  availableGA: boolean;
  latestVersionAlpha: string;
  latestVersionBeta: string;
  latestVersionGA: string;
};

export type AgentInfoResponse = {
  AvailableAgents?: AgentVersionInfo;
};
