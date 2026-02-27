export type RunMigrationScriptResult =
  | {
      success: true;
      output: string;
    }
  | {
      success: false;
      error: string;
      details?: string;
    };

export type RunMigrationScript = () => Promise<RunMigrationScriptResult>;
