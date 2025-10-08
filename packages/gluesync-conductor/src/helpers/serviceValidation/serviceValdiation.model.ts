import { RawComposeService } from '../../models/composeFile.model';
import { Service } from '../processService/processService.model';

export type ValidationResult = {
  success: boolean;
  errorMessage: string;
  statusCode: 200 | 400 | 404 | 409 | 500;
};

export type ServiceValidation = (
  validationMode: 'add' | 'edit',
  service: Service,
  currentServiceId: string,
  services?: Record<string, RawComposeService>,
) => ValidationResult;
