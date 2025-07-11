/**
 * Type declarations for gluesync-sdk
 */

declare module 'gluesync-sdk' {
  export interface GluesyncClientOptions {
    host?: string;
    port?: number;
    licenseFilePath?: string;
    moduleTag: string;
    useSSL?: boolean;
    securityConfig?: string;
    verifySSL?: boolean;
  }

  export class GluesyncClient {
    constructor(options: GluesyncClientOptions);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    on(event: string, callback: Function): void;
    host: string;
    port: number;
    useSSL: boolean;
    isConnected: boolean;
  }

  export class GluesyncConnectionError extends Error {
    constructor(message: string);
  }

  export class GluesyncLicenseError extends Error {
    constructor(message: string);
  }

  export class GluesyncAuthenticationError extends Error {
    constructor(message: string);
  }
}
