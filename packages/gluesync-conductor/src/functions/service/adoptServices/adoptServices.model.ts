import { RouteHandlerMethod } from 'fastify';
import { ErrorResponse } from '../../../models/common.model';
import {
  ComposeService,
  RawComposeService,
} from '../../../models/composeFile.model';
import { Service } from '../../../helpers/processService/processService.model';

export type EditServicesQuerystring = Readonly<{
  raw?: boolean;
}>;

export type EditServicesBody = Readonly<{
  services: readonly Service[];
}>;

export type ServiceResultItem =
  | {
      success: true;
      serviceId: string;
      service?: RawComposeService | ComposeService;
    }
  | { success: false; serviceId: string; error: string };

export type EditServicesSuccessResponse = {
  success: boolean;
  results: ReadonlyArray<ServiceResultItem>;
};

export type EditServicesResponse = EditServicesSuccessResponse | ErrorResponse;

export type EditServicesHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Querystring: EditServicesQuerystring;
    Body: Partial<EditServicesBody>;
    Reply: EditServicesResponse;
  }
>;
