const REDACTED_VALUE = '***REDACTED***';

const SENSITIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /password/i,
  /passwd/i,
  /pass$/i,
  /secret/i,
  /token/i,
  /credential/i,
  /\bkey\b/i,
  /auth/i,
  /api[-_]?secret/i,
  /api[-_]?key/i,
  /admin/i,
  /admin[-_]?user/i,
  /admin[-_]?password/i,
];

const isSensitive = (value: string): boolean =>
  SENSITIVE_PATTERNS.some(pattern => pattern.test(value));

type RedactableEnv =
  | Record<string, unknown>
  | ReadonlyArray<string>
  | undefined
  | null;

export const redactEnvironment = (env: RedactableEnv): typeof env => {
  if (!env) {
    return env;
  }

  if (Array.isArray(env)) {
    return env.map(entry => {
      const eqIndex = entry.indexOf('=');
      if (eqIndex === -1) {
        return entry;
      }
      const key = entry.slice(0, eqIndex);
      return isSensitive(key) ? `${key}=${REDACTED_VALUE}` : entry;
    });
  }

  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      isSensitive(key) ? REDACTED_VALUE : value,
    ]),
  ) as typeof env;
};

export const redactCommand = (
  command: ReadonlyArray<string> | undefined | null,
): ReadonlyArray<string> | undefined | null => {
  if (!command || !Array.isArray(command)) {
    return command;
  }

  return command.map((arg, i) => {
    if (i > 0 && isSensitive(command[i - 1])) {
      return REDACTED_VALUE;
    }
    return arg;
  });
};

export const redactService = (
  service: Record<string, unknown> | undefined | null,
): Record<string, unknown> | undefined | null => {
  if (!service || typeof service !== 'object') {
    return service;
  }

  return {
    ...service,
    environment: redactEnvironment(service.environment as RedactableEnv),
    command: redactCommand(
      service.command as ReadonlyArray<string> | undefined | null,
    ),
  };
};

export const redactServices = (
  services: Record<string, Record<string, unknown>> | undefined | null,
): Record<string, Record<string, unknown>> | undefined | null => {
  if (!services || typeof services !== 'object') {
    return services;
  }

  return Object.fromEntries(
    Object.entries(services).map(([name, service]) => [
      name,
      redactService(service) as Record<string, unknown>,
    ]),
  );
};

type RedactableContainerInfo = {
  Config?: {
    Env?: ReadonlyArray<string>;
    Cmd?: ReadonlyArray<string>;
  };
  [key: string]: unknown;
};

export const redactContainerInfo = (
  info: Record<string, unknown> | undefined | null,
): Record<string, unknown> | undefined | null => {
  if (!info || typeof info !== 'object') {
    return info;
  }

  const config = (info as RedactableContainerInfo).Config;
  if (!config) {
    return info;
  }

  return {
    ...info,
    Config: {
      ...config,
      Env: redactEnvironment(config.Env),
      Cmd: redactCommand(config.Cmd),
    },
  };
};
