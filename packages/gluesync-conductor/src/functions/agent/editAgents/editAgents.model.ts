import { RouteHandlerMethod } from 'fastify';
import { ErrorResponse } from '../../../models/common.model';
import { RawComposeService } from '../../../models/composeFile.model';
import { Agent } from '../../../helpers/processAgent/processAgent.model';

export type EditAgentsBody = Readonly<{
  agents: readonly Agent[];
}>;

export type AgentResultItem =
  | {
      success: true;
      serviceId: string;
      service: RawComposeService;
    }
  | { success: false; serviceId: string; error: string };

export type EditAgentsSuccessResponse = {
  success: boolean;
  results: Array<AgentResultItem>;
};

export type EditAgentsResponse = EditAgentsSuccessResponse | ErrorResponse;

export type EditAgentsHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Body: Partial<EditAgentsBody>;
    Reply: EditAgentsResponse;
  }
>;
