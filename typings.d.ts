declare namespace NodeJS {
  interface ProcessEnv {
    readonly NODE_ENV: string;
    readonly ENV: string;

    readonly DEBUG: string;
    readonly LOG_LEVEL: string;

    readonly PROJECT_CWD: string;
    readonly DKR_COMPOSE_FILE: string;
    readonly DKR_COMPOSE_FILE_SOURCE: string;

    readonly HOST: string;
    readonly PORT: string;
    readonly DOCKER_HOST: string;

    readonly CORE_HUB_NAME: string;
    readonly BASE_PATH: string;

    readonly USE_SDK: string;
    readonly SSL_SKIP_VERIFY: string;
    readonly SSL_ENABLED: string;
    readonly IS_INTEGRATION_TEST: string;
  }
}
