/**
 * Basic example of connecting to CoreHub using the Gluesync SDK.
 * 
 * This example demonstrates:
 * 1. Creating a GluesyncClient
 * 2. Setting up event handlers
 * 3. Connecting to CoreHub
 * 4. Handling the connection token
 * 5. Disconnecting after a timeout
 * 
 * Usage:
 * - Make sure you have a valid gs-license.dat file in the current directory
 * - Set the CORE_HUB_ADDRESS environment variable or use autodiscovery
 * - Run with: npx ts-node basic-connection.ts
 */

import { GluesyncClient } from '../src';

// Set up logging
const DEBUG = process.env.DEBUG || 'gluesync:*';
process.env.DEBUG = DEBUG;

async function main() {
  console.log('Starting Gluesync CoreHub connection example...');
  
  try {
    // Create the client with either a specific host or autodiscovery
    const client = new GluesyncClient({
      // If CORE_HUB_ADDRESS is set, it will be used instead of this host value
      host: process.env.CORE_HUB_ADDRESS || null,
      port: 1717,
      licenseFilePath: './gs-license.dat',
      moduleTag: 'nodejs-example',
      // Set to true if you need SSL
      ssl: false,
      // Uncomment if using SSL
      // keystorePath: './keystore.jks',
      // keystorePassword: 'password',
      timeout: 10000
    });
    
    // Set up event handlers
    client.onConnected = (token) => {
      console.log(`Connected to CoreHub successfully!`);
      console.log(`Received token: ${token.substring(0, 20)}...`);
    };
    
    client.onDisconnected = (reason) => {
      console.log(`Disconnected from CoreHub: ${reason}`);
    };
    
    client.onError = (error) => {
      console.error(`Error occurred: ${error.message}`);
    };
    
    // Connect to CoreHub
    console.log('Connecting to CoreHub...');
    const token = await client.connect();
    
    console.log(`Connection established with token: ${token.substring(0, 20)}...`);
    console.log(`Connected: ${client.isConnected}`);
    
    // Keep the connection alive for a while
    const connectionDuration = 10000; // 10 seconds
    console.log(`Keeping connection alive for ${connectionDuration / 1000} seconds...`);
    
    await new Promise(resolve => setTimeout(resolve, connectionDuration));
    
    // Disconnect
    console.log('Disconnecting from CoreHub...');
    await client.disconnect();
    
    console.log('Example completed successfully!');
  } catch (error) {
    console.error('Error in example:', error);
  }
}

// Run the example
main().catch(console.error);
