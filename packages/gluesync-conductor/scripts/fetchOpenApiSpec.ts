#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';

const DEFAULT_PORT: number = 50000;
const DEFAULT_HOST: string = 'localhost';

interface OpenApiSpec {
  info: { title: string; version: string };
  paths: Record<string, any>;
  [key: string]: any;
}

const startServer = async (): Promise<ChildProcess> =>
  new Promise((resolve, reject) => {
    console.log('🚀 Starting server...');

    const serverProcess = spawn('yarn', ['start'], {
      stdio: 'pipe',
      detached: false,
    });

    serverProcess.stdout?.on('data', data => {
      const output = data.toString();
      if (output.includes('server started') || output.includes('listening')) {
        console.log('✅ Server is ready!');
        resolve(serverProcess); // 👈 return the process
      }
    });

    serverProcess.stderr?.on('data', data => {
      console.error('Server error:', data.toString());
    });

    serverProcess.on('error', reject);

    setTimeout(() => {
      console.log('⏱️ Assuming server is ready (timeout)');
      resolve(serverProcess); // 👈 fallback return
    }, 8000);
  });

const stopServer = async (
  serverProcess: Readonly<ChildProcess>,
): Promise<void> => {
  console.log('🛑 Stopping server...');
  serverProcess.kill('SIGTERM');

  setTimeout(() => {
    if (!serverProcess.killed) {
      serverProcess.kill('SIGKILL');
    }
  }, 5000);
};

const fetchOpenApiSpec = async (): Promise<OpenApiSpec> => {
  const port: number = process.env.PORT
    ? parseInt(process.env.PORT, 10)
    : DEFAULT_PORT;
  const host: string = process.env.HOST || DEFAULT_HOST;
  const protocol: string =
    process.env.SSL_ENABLED === 'true' ? 'https' : 'http';

  const url: string = `${protocol}://${host === '0.0.0.0' ? 'localhost' : host}:${port}/openapi.json`;

  console.log(`📥 Fetching OpenAPI spec from: ${url}`);

  try {
    const response: Response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const openApiSpec: OpenApiSpec = await response.json();

    // Save to file
    const outputPath: string = path.resolve(process.cwd(), 'openapi.json');
    fs.writeFileSync(outputPath, JSON.stringify(openApiSpec, null, 2));

    console.log(`✅ OpenAPI spec saved to: ${outputPath}`);
    console.log(
      `📊 Found ${Object.keys(openApiSpec.paths || {}).length} endpoints`,
    );

    return openApiSpec;
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ Failed to fetch OpenAPI spec:', errorMessage);
    throw error;
  }
};

const main = async (): Promise<void> => {
  try {
    const serverProcess: ChildProcess = await startServer();

    process.on('SIGINT', async () => {
      console.log('\n🛑 Received SIGINT, stopping server...');
      if (serverProcess) {
        await stopServer(serverProcess);
      }
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\n🛑 Received SIGTERM, stopping server...');
      if (serverProcess) {
        await stopServer(serverProcess);
      }
      process.exit(0);
    });

    // additional timeout
    await new Promise<void>(resolve => {
      setTimeout(resolve, 2000);
    });

    await fetchOpenApiSpec();

    console.log('🎉 Done! Server will now stop.');
    if (serverProcess) {
      await stopServer(serverProcess);
    }
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ Script failed:', errorMessage);
  }
};

main();
