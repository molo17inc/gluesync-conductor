import { RouteHandlerMethod } from 'fastify';
import { ErrorResponse } from '../../../models/common.model';
import {
  ComposeService,
  RawComposeService,
} from '../../../models/composeFile.model';
import { Agent } from '../../../helpers/processAgent/processAgent.model';

export type EditAgentsQuerystring = Readonly<{
  raw?: boolean;
}>;

export type EditAgentsBody = Readonly<{
  agents: readonly Agent[];
}>;

export type AgentResultItem =
  | {
      success: true;
      serviceId: string;
      service?: RawComposeService | ComposeService;
    }
  | { success: false; serviceId: string; error: string };

export type EditAgentsSuccessResponse = {
  success: boolean;
  results: ReadonlyArray<AgentResultItem>;
};

export type EditAgentsResponse = EditAgentsSuccessResponse | ErrorResponse;

export type EditAgentsHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Querystring: EditAgentsQuerystring;
    Body: Partial<EditAgentsBody>;
    Reply: EditAgentsResponse;
  }
>;
