import { RouteHandlerMethod } from 'fastify';
import { ErrorResponse } from '../../../models/common.model';
import {
  ComposeService,
  RawComposeService,
} from '../../../models/composeFile.model';
import { Agent } from '../../../helpers/processAgent/processAgent.model';

export type AddAgentsQuerystring = Readonly<{
  raw?: boolean;
}>;

export type AddAgentsBody = Readonly<{
  agents: readonly Agent[];
}>;

export type AgentResultItem =
  | {
      success: true;
      serviceId: string;
      service?: RawComposeService | ComposeService;
    }
  | { success: false; serviceId: string; error: string };

export type AddAgentsSuccessResponse = {
  success: boolean;
  results: ReadonlyArray<AgentResultItem>;
};

export type AddAgentsResponse = AddAgentsSuccessResponse | ErrorResponse;

export type AddAgentsHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Querystring: AddAgentsQuerystring;
    Body: Partial<AddAgentsBody>;
    Reply: AddAgentsResponse;
  }
>;
