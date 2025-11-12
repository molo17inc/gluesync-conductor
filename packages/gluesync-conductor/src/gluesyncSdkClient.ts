import { Logger } from 'pino';
import { GluesyncSDKClient } from 'gluesync-sdk-client';

// Singleton instance for Gluesync SDK client
declare global {
  // Allow global singleton across reloads in dev
  // eslint-disable-next-line no-var, vars-on-top
  var gluesyncSdkClient: GluesyncSDKClient | undefined;
}

function createGluesyncSdkClient(logger?: Logger): GluesyncSDKClient {
  // Get the singleton instance from the SDK
  return GluesyncSDKClient.getInstance(logger);
}

export function getGluesyncSdkClient(logger?: Logger): GluesyncSDKClient {
  if (!global.gluesyncSdkClient) {
    // eslint-disable-next-line functional/immutable-data
    global.gluesyncSdkClient = createGluesyncSdkClient(logger);
  }
  return global.gluesyncSdkClient;
}

// Optional: Add error logging wrapper if you want parity with Python
export function withCoreHubDiscoveryErrorLogging<T>(
  promise: Promise<T>,
): Promise<T> {
  return promise.catch(error => {
    // Replace with your preferred logger if needed
    // eslint-disable-next-line no-console
    console.error('Error in CoreHub discovery:', error);
    throw error;
  });
}
