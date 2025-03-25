/**
 * Tests for the GluesyncClient class.
 */

import * as fs from 'fs-extra';
import { GluesyncClient } from '../src/client';
import { WebSocketConnection } from '../src/connection';
import * as discovery from '../src/discovery';
import * as utils from '../src/utils';
import {
  GluesyncConnectionError,
  GluesyncAuthenticationError,
  GluesyncLicenseError,
  GluesyncSSLError
} from '../src/exceptions';

// Mock dependencies
jest.mock('fs-extra');
jest.mock('../src/connection');
jest.mock('../src/discovery');
jest.mock('../src/utils');

describe('GluesyncClient', () => {
  let client: GluesyncClient;
  
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Mock fs.existsSync to return true for license file
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    
    // Mock fs.readFileSync to return a mock license content
    (fs.readFileSync as jest.Mock).mockReturnValue('mock-license-content');
    
    // Mock getCorehubAddress to return a mock address
    (discovery.getCorehubAddress as jest.Mock).mockResolvedValue('192.168.1.100');
    
    // Mock createSslContextFromJks to return mock SSL options
    (utils.createSslContextFromJks as jest.Mock).mockResolvedValue({
      ca: 'mock-ca',
      cert: 'mock-cert',
      key: 'mock-key'
    });
    
    // Mock WebSocketConnection.connect to return a mock token
    (WebSocketConnection.prototype.connect as jest.Mock).mockResolvedValue('jwt-token-123');
    
    // Mock WebSocketConnection.isConnected getter
    Object.defineProperty(WebSocketConnection.prototype, 'isConnected', {
      get: jest.fn().mockReturnValue(true),
      configurable: true
    });
    
    // Always use localhost since CoreHub is running in the same container
    const host = 'localhost';
    
    // Create client instance with the actual license file
    client = new GluesyncClient({
      host: host,
      port: 1717,
      licenseFilePath: './gs-license.dat',
      moduleTag: 'test-module'
    });
  });
  
  test('should initialize with correct parameters', () => {
    expect(client).toBeDefined();
    expect(client.isConnected).toBe(false);
    expect(client.token).toBeNull();
    expect(client.connectionStatus).toBe('Not initialized');
  });
  
  test('should connect successfully with explicit host', async () => {
    // Connect to the server
    const token = await client.connect();
    
    // Verify that WebSocketConnection was created with correct parameters
    expect(WebSocketConnection).toHaveBeenCalledWith(
      'localhost',
      1717,
      expect.objectContaining({
        'Module-License': 'mock-license-content',
        'Module-Tag': 'test-module'
      }),
      null,
      1000,
      10000
    );
    
    // Verify that WebSocketConnection.connect was called
    expect(WebSocketConnection.prototype.connect).toHaveBeenCalled();
    
    // Verify the token
    expect(token).toBe('jwt-token-123');
    expect(client.token).toBe('jwt-token-123');
    expect(client.isConnected).toBe(true);
  });
  
  test('should use autodiscovery when host is null', async () => {
    // Create client with null host
    client = new GluesyncClient({
      host: null,
      port: 1717,
      licenseFilePath: './gs-license.dat',
      moduleTag: 'test-module'
    });
    
    // Connect to the server
    await client.connect();
    
    // Verify that getCorehubAddress was called
    expect(discovery.getCorehubAddress).toHaveBeenCalledWith(
      'CORE_HUB_ADDRESS',
      1717,
      10,
      10000
    );
    
    // Verify that WebSocketConnection was created with the discovered address
    expect(WebSocketConnection).toHaveBeenCalledWith(
      '192.168.1.100',
      1717,
      expect.any(Object),
      null,
      1000,
      10000
    );
  });
  
  test('should use SSL when keystorePath is provided', async () => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Mock createSslContextFromJks to return mock SSL options
    (utils.createSslContextFromJks as jest.Mock).mockResolvedValue({
      ca: 'mock-ca',
      cert: 'mock-cert',
      key: 'mock-key'
    });
    
    // Create client with SSL enabled
    client = new GluesyncClient({
      host: 'localhost',
      port: 1717,
      licenseFilePath: './gs-license.dat',
      moduleTag: 'test-module',
      ssl: true,
      keystorePath: 'keystore.jks',
      keystorePassword: 'password'
    });
    
    // Set environment variables for keystore path and password
    process.env.KEYSTORE_PATH = 'keystore.jks';
    process.env.KEYSTORE_PASSWORD = 'password';
    
    // Connect to the server
    await client.connect();
    
    // Verify that createSslContextFromJks was called
    expect(utils.createSslContextFromJks).toHaveBeenCalledWith(
      'keystore.jks',
      'password'
    );
    
    // Verify that WebSocketConnection was created with SSL options
    expect(WebSocketConnection).toHaveBeenCalledWith(
      'localhost',
      1717,
      expect.any(Object),
      {
        ca: 'mock-ca',
        cert: 'mock-cert',
        key: 'mock-key'
      },
      1000,
      10000
    );
    
    // Clean up environment variables
    delete process.env.KEYSTORE_PATH;
    delete process.env.KEYSTORE_PASSWORD;
  });
  
  test('should handle connection errors', async () => {
    // Mock WebSocketConnection.connect to throw an error
    (WebSocketConnection.prototype.connect as jest.Mock).mockRejectedValue(
      new GluesyncConnectionError('Connection failed')
    );
    
    // Expect connect to throw an error
    await expect(client.connect()).rejects.toThrow(GluesyncConnectionError);
    expect(client.isConnected).toBe(false);
  });
  
  test('should handle authentication errors', async () => {
    // Mock WebSocketConnection.connect to throw an authentication error
    (WebSocketConnection.prototype.connect as jest.Mock).mockRejectedValue(
      new GluesyncAuthenticationError('Authentication failed')
    );
    
    // Expect connect to throw an authentication error
    await expect(client.connect()).rejects.toThrow(GluesyncAuthenticationError);
    expect(client.isConnected).toBe(false);
  });
  
  test('should handle license errors', async () => {
    // Create a client with a non-existent license file
    const clientWithInvalidLicense = new GluesyncClient({
      host: 'localhost',
      port: 1717,
      licenseFilePath: './non-existent-license.dat',
      moduleTag: 'test-module'
    });
    
    // Mock fs.existsSync to return false for the non-existent license file
    (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
      return path !== './non-existent-license.dat';
    });
    
    // Expect connect to throw a license error
    await expect(clientWithInvalidLicense.connect()).rejects.toThrow(GluesyncLicenseError);
    expect(clientWithInvalidLicense.isConnected).toBe(false);
  });
  
  test('should handle SSL errors', async () => {
    // Create client with SSL enabled
    client = new GluesyncClient({
      host: 'localhost',
      port: 1717,
      licenseFilePath: './gs-license.dat',
      moduleTag: 'test-module',
      ssl: true,
      keystorePath: 'keystore.jks',
      keystorePassword: 'password'
    });
    
    // Set environment variables for keystore path and password
    process.env.KEYSTORE_PATH = 'keystore.jks';
    process.env.KEYSTORE_PASSWORD = 'password';
    
    // Mock createSslContextFromJks to throw an error
    (utils.createSslContextFromJks as jest.Mock).mockRejectedValue(
      new Error('SSL error')
    );
    
    // Expect connect to throw an SSL error
    await expect(client.connect()).rejects.toThrow(GluesyncSSLError);
    expect(client.isConnected).toBe(false);
    
    // Clean up environment variables
    delete process.env.KEYSTORE_PATH;
    delete process.env.KEYSTORE_PASSWORD;
  });
  
  test('should disconnect successfully', async () => {
    // First connect
    await client.connect();
    
    // Mock the connection state to be disconnected after disconnect is called
    (WebSocketConnection.prototype.disconnect as jest.Mock).mockImplementation(() => {
      Object.defineProperty(WebSocketConnection.prototype, 'isConnected', {
        get: jest.fn().mockReturnValue(false),
        configurable: true
      });
      return Promise.resolve();
    });
    
    // Then disconnect
    await client.disconnect();
    
    // Verify that WebSocketConnection.disconnect was called
    expect(WebSocketConnection.prototype.disconnect).toHaveBeenCalled();
    
    // Verify the connection state
    expect(client.isConnected).toBe(false);
  });
  
  test('should emit events', async () => {
    // Create event listeners
    const connectedListener = jest.fn();
    const disconnectedListener = jest.fn();
    const errorListener = jest.fn();
    
    // Register event listeners
    client.on('connected', connectedListener);
    client.on('disconnected', disconnectedListener);
    client.on('error', errorListener);
    
    // Connect
    await client.connect();
    
    // Get the connection instance
    const connectionInstance = (WebSocketConnection as unknown as jest.Mock).mock.instances[0];
    
    // Call the event handlers directly
    if (connectionInstance.onConnected) {
      await connectionInstance.onConnected('jwt-token-123');
    }
    
    if (connectionInstance.onDisconnected) {
      await connectionInstance.onDisconnected('Test disconnection');
    }
    
    if (connectionInstance.onError) {
      await connectionInstance.onError(new Error('Test error'));
    }
    
    // Verify that event listeners were called
    expect(connectedListener).toHaveBeenCalledWith('jwt-token-123');
    expect(disconnectedListener).toHaveBeenCalledWith('Test disconnection');
    expect(errorListener).toHaveBeenCalledWith(new Error('Test error'));
  });
});
