declare namespace NodeJS {
  interface ProcessEnv {
    readonly NODE_ENV: string;
    readonly ENV: string;

    readonly DEBUG: string;
  }
}
