import { RawComposeService } from '../../models/composeFile.model';
import { Agent } from '../processAgent/processAgent.model';

export type ValidationResult = {
  success: boolean;
  errorMessage: string;
  statusCode: 200 | 400 | 404 | 409 | 500;
};

export type AgentValidation = (
  validationMode: 'add' | 'edit',
  agent: Agent,
  services?: Record<string, RawComposeService>,
) => ValidationResult;
