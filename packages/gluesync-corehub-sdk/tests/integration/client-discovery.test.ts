/**
 * Test for the GluesyncClient with UDP autodiscovery.
 * This test mimics the Python test_client_discovery.py by mocking CoreHub functionality.
 */

import * as fs from 'fs-extra';
import { GluesyncClient } from '../../src/client';
import { WebSocketConnection } from '../../src/connection';
import * as discovery from '../../src/discovery';

// Mock dependencies
jest.mock('fs-extra');
jest.mock('../../src/connection');
jest.mock('../../src/discovery');

// Constants
const START_PORT = 1717;
const PORT_RANGE = 10;
const MOCK_COREHUB_ADDRESS = '192.168.1.100';
const MOCK_LICENSE_CONTENT = 'mock-license-content';

describe('GluesyncClient with Autodiscovery', () => {
  let client: GluesyncClient;
  
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    jest.resetAllMocks();
    
    // Mock fs.existsSync to return true for license file
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    
    // Mock fs.readFileSync to return a mock license content
    (fs.readFileSync as jest.Mock).mockReturnValue(MOCK_LICENSE_CONTENT);
    
    // Mock getCorehubAddress to return a mock address
    (discovery.getCorehubAddress as jest.Mock).mockResolvedValue(MOCK_COREHUB_ADDRESS);
    
    // Mock WebSocketConnection.connect to return a mock token
    (WebSocketConnection.prototype.connect as jest.Mock).mockResolvedValue('jwt-token-123');
    
    // Mock WebSocketConnection.isConnected getter
    Object.defineProperty(WebSocketConnection.prototype, 'isConnected', {
      get: jest.fn().mockReturnValue(true),
      configurable: true
    });
  });
  
  test('should use autodiscovery when host is null', async () => {
    // Create client with null host to trigger autodiscovery
    client = new GluesyncClient({
      host: null,
      port: START_PORT,
      licenseFilePath: './dummy-license.dat',
      moduleTag: 'test-module',
      discoveryStartPort: START_PORT,
      discoveryPortRange: PORT_RANGE
    });
    
    // Connect to the server - this should trigger autodiscovery
    await client.connect();
    
    // Verify that getCorehubAddress was called with the correct parameters
    expect(discovery.getCorehubAddress).toHaveBeenCalledWith(
      'CORE_HUB_ADDRESS',
      START_PORT,
      PORT_RANGE,
      10000 // default timeout
    );
    
    // Verify that WebSocketConnection was created with the discovered address
    expect(WebSocketConnection).toHaveBeenCalledWith(
      MOCK_COREHUB_ADDRESS,
      START_PORT,
      expect.any(Object),
      null, // no SSL
      1000, // default reconnect delay
      10000 // default timeout
    );
    
    // Verify the client is using the discovered host by checking the WebSocketConnection
    expect(WebSocketConnection).toHaveBeenCalledWith(
      MOCK_COREHUB_ADDRESS,
      START_PORT,
      expect.any(Object),
      null,
      1000,
      10000
    );
  });
  
  test('should handle discovery errors gracefully', async () => {
    // Mock getCorehubAddress to throw an error
    (discovery.getCorehubAddress as jest.Mock).mockRejectedValue(
      new Error('Discovery failed')
    );
    
    // Create client with null host to trigger autodiscovery
    client = new GluesyncClient({
      host: null,
      port: START_PORT,
      licenseFilePath: './dummy-license.dat',
      moduleTag: 'test-module'
    });
    
    // Connect should fail with discovery error
    await expect(client.connect()).rejects.toThrow('Discovery failed');
    
    // Verify that WebSocketConnection was not created
    expect(WebSocketConnection).not.toHaveBeenCalled();
  });
  
  test('should use explicit host when provided', async () => {
    // Create client with explicit host
    client = new GluesyncClient({
      host: 'explicit-host',
      port: START_PORT,
      licenseFilePath: './dummy-license.dat',
      moduleTag: 'test-module'
    });
    
    // Connect to the server
    await client.connect();
    
    // Verify that getCorehubAddress was NOT called
    expect(discovery.getCorehubAddress).not.toHaveBeenCalled();
    
    // Verify that WebSocketConnection was created with the explicit host
    expect(WebSocketConnection).toHaveBeenCalledWith(
      'explicit-host',
      START_PORT,
      expect.any(Object),
      null,
      1000,
      10000
    );
  });
});
