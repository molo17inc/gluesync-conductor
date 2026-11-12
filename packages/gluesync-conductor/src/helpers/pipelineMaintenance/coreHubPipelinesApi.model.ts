// What the update needs of a pipeline, from `GET /pipelines` (PipelineResponseDto
// in gluesync-kotlin commons-model).
export type CoreHubPipeline = Readonly<{
  id: string;
  name?: string;
  configurationCompleted: boolean;
  isInMaintenanceMode: boolean;
}>;

export type CoreHubPipelinesApi = Readonly<{
  /** `GET /pipelines` */
  listPipelines: () => Promise<ReadonlyArray<CoreHubPipeline>>;
  /** `GET /pipelines/{id}/entities-status`: any entity syncing or migrating */
  isRunning: (pipelineId: string) => Promise<boolean>;
  /** `POST /pipelines/{id}/commands/maintenance/enter`: drains and stops sync */
  enterMaintenance: (pipelineId: string) => Promise<void>;
  /** `POST /pipelines/{id}/commands/maintenance/exit`: restarts what was running */
  exitMaintenance: (pipelineId: string) => Promise<void>;
}>;

// eslint-disable-next-line functional/no-mixed-types -- providers next to settings, like the introspector's config
export type CoreHubPipelinesApiOptions = Readonly<{
  baseUrl?: () => string | null;
  token?: () => string | null;
  verifySsl?: boolean;
  // Reads; a maintenance command gets commandTimeoutMs
  timeoutMs?: number;
  // Core Hub answers enter/exit once the pipeline is drained or restarted: it
  // can take minutes (its own REST timeout is 10 minutes)
  commandTimeoutMs?: number;
}>;
