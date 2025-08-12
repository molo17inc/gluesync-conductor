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

let serverProcess: ChildProcess | null = null;

async function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log('🚀 Starting server...');

    serverProcess = spawn('yarn', ['start'], {
      stdio: 'pipe',
      detached: false,
    });

    serverProcess.stdout?.on('data', data => {
      const output = data.toString();
      if (output.includes('server started') || output.includes('listening')) {
        console.log('✅ Server is ready!');
        resolve();
      }
    });

    serverProcess.stderr?.on('data', data => {
      console.error('Server error:', data.toString());
    });

    serverProcess.on('error', reject);

    // Fallback timeout
    setTimeout(() => {
      console.log('⏱️ Assuming server is ready (timeout)');
      resolve();
    }, 8000);
  });
}

async function stopServer(): Promise<void> {
  if (serverProcess) {
    console.log('🛑 Stopping server...');
    serverProcess.kill('SIGTERM');

    // Force kill after 5 seconds if not stopped
    setTimeout(() => {
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill('SIGKILL');
      }
    }, 5000);
  }
}

async function fetchOpenApiSpec(): Promise<OpenApiSpec> {
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
}

async function main(): Promise<void> {
  try {
    // Start server
    await startServer();

    // Wait a bit more for full initialization
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Fetch OpenAPI spec
    await fetchOpenApiSpec();

    console.log('🎉 Done! Server will now stop.');
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ Script failed:', errorMessage);
  } finally {
    // Always stop the server
    await stopServer();
    process.exit(0);
  }
}

// Handle process termination
process.on('SIGINT', async () => {
  console.log('\n🛑 Received SIGINT, stopping server...');
  await stopServer();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM, stopping server...');
  await stopServer();
  process.exit(0);
});

main();
