import { RouteHandlerMethod } from 'fastify';
import { ErrorResponse } from '../../../models/common.model';
import {
  ComposeService,
  RawComposeService,
} from '../../../models/composeFile.model';
import { Service } from '../../../helpers/processService/processService.model';

export type AddServicesQuerystring = Readonly<{
  raw?: boolean;
}>;

export type AddServicesBody = Readonly<{
  services: readonly Service[];
}>;

export type ServiceResultItem =
  | {
      success: true;
      serviceId: string;
      service?: RawComposeService | ComposeService;
    }
  | { success: false; error: string };

export type AddServicesSuccessResponse = {
  success: boolean;
  results: ReadonlyArray<ServiceResultItem>;
};

export type AddServicesResponse = AddServicesSuccessResponse | ErrorResponse;

export type AddServicesHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Querystring: AddServicesQuerystring;
    Body: Partial<AddServicesBody>;
    Reply: AddServicesResponse;
  }
>;
