import { RouteHandlerMethod } from 'fastify';
import { ErrorResponse } from '../../../models/common.model';
import { RawComposeService } from '../../../models/composeFile.model';
import { Agent } from '../../../helpers/processAgent/processAgent.model';

export type AddAgentsBody = Readonly<{
  agents: readonly Agent[];
}>;

export type AgentResultItem =
  | {
      success: true;
      serviceId: string;
      service: RawComposeService;
    }
  | { success: false; serviceId: string; error: string };

export type AddAgentsSuccessResponse = {
  success: boolean;
  results: Array<AgentResultItem>;
};

export type AddAgentsResponse = AddAgentsSuccessResponse | ErrorResponse;

export type AddAgentsHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Body: Partial<AddAgentsBody>;
    Reply: AddAgentsResponse;
  }
>;
