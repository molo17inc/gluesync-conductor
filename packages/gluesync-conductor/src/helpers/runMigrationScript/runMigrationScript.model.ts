import { ErrorResponse, SuccessResponse } from '../../models/common.model';

export type RunMigrationScript = () => Promise<
  SuccessResponse<string> | ErrorResponse
>;
