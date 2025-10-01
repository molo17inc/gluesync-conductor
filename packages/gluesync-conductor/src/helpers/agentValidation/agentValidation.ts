import { AgentValidation } from './agentValdiation.model';

const agentValidation: AgentValidation = (
  validationMode,
  agent,
  currentServiceId,
  services,
) => {
  const { type, nickname } = agent;
  const existingService = services?.[currentServiceId];

  if (validationMode === 'add' && !!existingService) {
    return {
      success: false,
      errorMessage: 'Agent already existing in file',
      statusCode: 409,
    };
  }

  if (validationMode === 'edit' && !existingService) {
    return {
      success: false,
      errorMessage: 'Agent not existing in file',
      statusCode: 404,
    };
  }

  if (!type) {
    return {
      success: false,
      errorMessage: 'Agent type missing',
      statusCode: 400,
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

export default agentValidation;
