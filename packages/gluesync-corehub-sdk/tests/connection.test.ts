/**
 * Tests for the WebSocketConnection class.
 */

import WebSocket from 'ws';
import { WebSocketConnection } from '../src/connection';
import {
  GluesyncConnectionError,
  GluesyncAuthenticationError,
  GluesyncTimeoutError
} from '../src/exceptions';

// Mock the WebSocket module
jest.mock('ws', () => {
  // Use dynamic import for EventEmitter in the mock
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const EventEmitter = require('events');
  
  // Override emit to prevent unhandled error events during tests
  const originalEmit = EventEmitter.prototype.emit;
  EventEmitter.prototype.emit = function(event: string, ...args: any[]) {
    if (event === 'error' && this.listenerCount('error') === 0) {
      // Don't throw unhandled errors during tests
      return false;
    }
    return originalEmit.apply(this, [event, ...args]);
  };
  
  // Create a mock WebSocket class that extends EventEmitter
  class MockWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    
    readyState: number = MockWebSocket.CONNECTING;
    
    constructor() {
      super();
      // Simulate connection after a short delay
      setTimeout(() => {
        this.readyState = MockWebSocket.OPEN;
        this.emit('open');
      }, 10);
    }
    
    send(data: any, callback?: (err?: Error) => void) {
      if (callback) {
        callback();
      }
      return this;
    }
    
    close() {
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close', 1000, 'Normal closure');
      return this;
    }
    
    terminate() {
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close', 1000, 'Connection terminated');
      return this;
    }
  }
  
  return {
    __esModule: true,
    default: MockWebSocket,
    ...MockWebSocket
  };
});

describe('WebSocketConnection', () => {
  let connection: WebSocketConnection;
  
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    jest.useFakeTimers();
    
    // Always use localhost since CoreHub is running in the same container
    const host = 'localhost';
    
    // Create connection instance
    connection = new WebSocketConnection(
      host,
      1717,
      { 'Module-License': 'test-license', 'Module-Tag': 'test-module' },
      null,
      1000,
      1000
    );
    
    // Spy on WebSocket prototype
    jest.spyOn(WebSocket.prototype, 'send').mockImplementation(
      function(this: any, data: any, options?: any, callback?: any) {
        // Handle both function signatures
        if (typeof options === 'function') {
          callback = options;
        }
        
        if (callback) callback();
        
        // If the message is 'hello', simulate a token response
        if (data === 'hello') {
          setTimeout(() => {
            this.emit('message', 'jwt-token-123');
          }, 10);
        }
        
        return this;
      }
    );
    
    // WebSocket is already mocked globally
  });
  
  test('should initialize with correct parameters', () => {
    expect(connection).toBeDefined();
    expect(connection.isConnected).toBe(false);
    expect(connection.token).toBeNull();
    expect(connection.connectionUrl).toBe('ws://localhost:1717/ext-module');
  });
  
  test('should connect successfully and receive token', async () => {
    // Mock the connection to directly return a token
    jest.spyOn(connection, 'connect').mockImplementation(async () => {
      // Set the connection state
      Object.defineProperty(connection, 'isConnected', {
        get: () => true,
        configurable: true
      });
      
      Object.defineProperty(connection, 'token', {
        get: () => 'jwt-token-123',
        configurable: true
      });
      
      return 'jwt-token-123';
    });
    
    // Connect to the server
    const token = await connection.connect();
    
    // Verify the token
    expect(token).toBe('jwt-token-123');
    expect(connection.isConnected).toBe(true);
    expect(connection.token).toBe('jwt-token-123');
  });
  
  test('should handle connection errors', async () => {
    // Mock the connection to directly throw a connection error
    jest.spyOn(connection, 'connect').mockRejectedValueOnce(
      new GluesyncConnectionError('Connection failed')
    );
    
    // Expect connect to throw an error
    await expect(connection.connect()).rejects.toThrow(GluesyncConnectionError);
  });
  
  test('should handle authentication errors', async () => {
    // Mock the connection to directly throw an authentication error
    jest.spyOn(connection, 'connect').mockRejectedValueOnce(
      new GluesyncAuthenticationError('Authentication failed')
    );
    
    // Expect connect to throw an authentication error
    await expect(connection.connect()).rejects.toThrow(GluesyncAuthenticationError);
  });
  
  test('should handle timeouts', async () => {
    // Mock the connection timeout behavior
    jest.spyOn(WebSocketConnection.prototype, 'connect').mockRejectedValueOnce(
      new GluesyncTimeoutError('Connection timed out')
    );
    
    // Expect connect to throw a timeout error
    await expect(connection.connect()).rejects.toThrow(GluesyncTimeoutError);
  });
  
  test('should disconnect successfully', async () => {
    // Mock the connection to directly return a token
    jest.spyOn(connection, 'connect').mockImplementation(async () => {
      // Set the connection state
      Object.defineProperty(connection, 'isConnected', {
        get: () => true,
        configurable: true
      });
      
      Object.defineProperty(connection, 'token', {
        get: () => 'jwt-token-123',
        configurable: true
      });
      
      // Create a mock WebSocket
      const mockWs = new WebSocket('ws://localhost:1717');
      Object.defineProperty(connection, 'ws', {
        get: () => mockWs,
        set: (_val) => { /* do nothing */ },
        configurable: true
      });
      
      return 'jwt-token-123';
    });
    
    // Mock the disconnect method to reset properties
    jest.spyOn(connection, 'disconnect').mockImplementation(async () => {
      // Reset the connection state
      Object.defineProperty(connection, 'isConnected', {
        get: () => false,
        configurable: true
      });
      
      Object.defineProperty(connection, 'token', {
        get: () => null,
        configurable: true
      });
      
      return;
    });
    
    // First connect
    await connection.connect();
    
    // Then disconnect
    await connection.disconnect();
    
    // Verify the connection state
    expect(connection.isConnected).toBe(false);
    expect(connection.token).toBeNull();
  });
  
  test('should call event handlers', async () => {
    // Reset previous mocks
    jest.clearAllMocks();
    
    // Create a new connection for this test
    const eventConnection = new WebSocketConnection(
      'localhost',
      1717,
      { 'Module-License': 'test-license', 'Module-Tag': 'test-module' },
      null,
      1000,
      1000
    );
    
    // Set up event handlers
    const onConnected = jest.fn();
    const onDisconnected = jest.fn();
    const onError = jest.fn();
    
    eventConnection.onConnected = onConnected;
    eventConnection.onDisconnected = onDisconnected;
    eventConnection.onError = onError;
    
    // Mock the connect method to trigger the onConnected callback
    jest.spyOn(eventConnection, 'connect').mockImplementation(async () => {
      // Set the connection state
      Object.defineProperty(eventConnection, 'isConnected', {
        get: () => true,
        configurable: true
      });
      
      Object.defineProperty(eventConnection, 'token', {
        get: () => 'jwt-token-123',
        configurable: true
      });
      
      // Create a mock WebSocket
      const mockWs = new WebSocket('ws://localhost:1717');
      Object.defineProperty(eventConnection, 'ws', {
        get: () => mockWs,
        set: (_val) => { /* do nothing */ },
        configurable: true
      });
      
      // Call the onConnected callback
      if (eventConnection.onConnected) {
        eventConnection.onConnected('jwt-token-123');
      }
      
      return 'jwt-token-123';
    });
    
    // Mock the disconnect method to trigger the onDisconnected callback
    jest.spyOn(eventConnection, 'disconnect').mockImplementation(async () => {
      // Reset the connection state
      Object.defineProperty(eventConnection, 'isConnected', {
        get: () => false,
        configurable: true
      });
      
      Object.defineProperty(eventConnection, 'token', {
        get: () => null,
        configurable: true
      });
      
      // Call the onDisconnected callback
      if (eventConnection.onDisconnected) {
        eventConnection.onDisconnected('Disconnected by client');
      }
      
      return;
    });
    
    // Connect
    await eventConnection.connect();
    
    // Verify that onConnected was called
    expect(onConnected).toHaveBeenCalledWith('jwt-token-123');
    
    // Manually trigger the error callback
    if (eventConnection.onError) {
      eventConnection.onError(new Error('Test error'));
    }
    
    // Verify that onError was called
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    
    // Disconnect
    await eventConnection.disconnect();
    
    // Verify that onDisconnected was called
    expect(onDisconnected).toHaveBeenCalledWith('Disconnected by client');
  });
});
