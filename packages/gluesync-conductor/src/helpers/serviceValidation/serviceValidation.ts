import { LabelPrefix } from '../../models/composeFile.model';
import { ConductorServiceTypes } from '../../models/conductor.model';
import { ServiceValidation } from './serviceValdiation.model';

const serviceValidation: ServiceValidation = (
  validationMode,
  service,
  currentServiceId,
  services,
) => {
  const { type, nickname, agentType } = service;
  const existingService = services?.[currentServiceId];

  if (validationMode === 'add') {
    if (existingService) {
      return {
        success: false,
        errorMessage: 'Service already existing in file',
        statusCode: 409,
      };
    }
    if (!service.id) {
      return {
        success: false,
        errorMessage: 'Service INITIAL_AGENT_ID cannot be null',
        statusCode: 500,
      };
    }
  }

  if (validationMode === 'edit') {
    if (!existingService) {
      return {
        success: false,
        errorMessage: 'Service not existing in file',
        statusCode: 404,
      };
    }

    const existingType = existingService?.labels
      ?.find(label => label.startsWith(`${LabelPrefix.CONDUCTOR}.type=`))
      ?.split('=')[1] as ConductorServiceTypes | undefined;

    if (type !== existingType) {
      return {
        success: false,
        errorMessage: 'Service type cannot be changed',
        statusCode: 400,
      };
    }
  }

  if (!type) {
    return {
      success: false,
      errorMessage: 'Service type missing',
      statusCode: 400,
    };
  }

  if (type === 'agent' && !agentType) {
    return {
      success: false,
      errorMessage:
        'Service of type agent must have an agent type (source, target)',
      statusCode: 409,
    };
  }
  if (type === 'module' && agentType) {
    return {
      success: false,
      errorMessage: `Service of type module don't have an agent type (source, target), did you mean to ${validationMode} an agent?`,
      statusCode: 409,
    };
  }

  const nicknameAlreadyExisting = Object.entries(services ?? {}).some(
    ([serviceId, service]) =>
      !!nickname &&
      serviceId !== currentServiceId &&
      nickname === service.container_name,
  );

  if (nicknameAlreadyExisting) {
    return {
      success: false,
      errorMessage: 'Nickname already present',
      statusCode: 500,
    };
  }

  return {
    success: true,
    errorMessage: '',
    statusCode: 200,
  };
};

export default serviceValidation;
