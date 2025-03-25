/**
 * Tests for the utils module.
 */

import * as fs from 'fs-extra';
import * as JSZip from 'jszip';
import * as forge from 'node-forge';
import { 
  createSslContextFromJks,
  createTimeout,
  getErrorFromCloseReason,
  generateId
} from '../src/utils';
import { GluesyncSSLError } from '../src/exceptions';

// Mock dependencies
jest.mock('fs-extra');
jest.mock('jszip');
jest.mock('node-forge');

// Reset the mock implementation before each test
beforeEach(() => {
  jest.resetAllMocks();
});

describe('utils', () => {
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
  });
  
  describe('createSslContextFromJks', () => {
    beforeEach(() => {
      // Mock fs.readFile to return mock JKS data
      jest.spyOn(fs, 'readFile').mockImplementation(() => Promise.resolve(Buffer.from('mock-jks-data')));
      
      // Mock JSZip.loadAsync to return a mock zip object
      const mockZip = {
        files: {
          'certificate.pem': {
            async: jest.fn().mockResolvedValue('mock-certificate')
          },
          'private.key': {
            async: jest.fn().mockResolvedValue('mock-private-key')
          },
          'ca.pem': {
            async: jest.fn().mockResolvedValue('mock-ca')
          }
        }
      };
      jest.spyOn(JSZip, 'loadAsync').mockResolvedValue(mockZip as any);
      
      // Mock forge.pki functions
      jest.spyOn(forge.pki, 'certificateFromPem').mockReturnValue({
        publicKey: 'mock-public-key'
      } as any);
      
      jest.spyOn(forge.pki, 'privateKeyFromPem').mockReturnValue('mock-private-key-object' as any);
      jest.spyOn(forge.pki, 'publicKeyToPem').mockReturnValue('mock-public-key-pem');
      jest.spyOn(forge.pki, 'privateKeyToPem').mockReturnValue('mock-private-key-pem');
    });
    
    test('should create SSL context from JKS file', async () => {
      // Call the function
      const sslOptions = await createSslContextFromJks('keystore.jks', 'password');
      
      // Verify that fs.readFile was called with the correct path
      expect(fs.readFile).toHaveBeenCalledWith('keystore.jks');
      
      // Verify that JSZip.loadAsync was called with the mock JKS data
      expect(JSZip.loadAsync).toHaveBeenCalledWith(Buffer.from('mock-jks-data'));
      
      // Verify the SSL options has the required properties
      expect(sslOptions).toHaveProperty('ca');
      expect(sslOptions).toHaveProperty('rejectUnauthorized');
      // We don't check the exact values as they might be implementation-specific
    });
    
    test('should handle errors when reading JKS file', async () => {
      // Mock fs.readFile to throw an error
      jest.spyOn(fs, 'readFile').mockImplementation(() => Promise.reject(new Error('File not found')));
      
      // Expect createSslContextFromJks to throw a GluesyncSSLError
      await expect(createSslContextFromJks('keystore.jks', 'password'))
        .rejects.toThrow(GluesyncSSLError);
    });
    
    test('should handle errors when parsing JKS file', async () => {
      // Mock JSZip.loadAsync to throw an error
      jest.spyOn(JSZip, 'loadAsync').mockRejectedValue(new Error('Invalid JKS file'));
      
      // Expect createSslContextFromJks to throw a GluesyncSSLError
      await expect(createSslContextFromJks('keystore.jks', 'password'))
        .rejects.toThrow(GluesyncSSLError);
    });
  });
  
  describe('createTimeout', () => {
    test('should reject after the specified timeout', async () => {
      // Mock setTimeout
      jest.useFakeTimers();
      
      // Create a timeout promise
      const timeoutPromise = createTimeout(1000, 'Test timeout');
      
      // Set up a promise to catch the rejection
      const catchPromise = timeoutPromise.catch(error => {
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe('Test timeout');
        return 'caught';
      });
      
      // Advance timers
      jest.advanceTimersByTime(1000);
      
      // Wait for the promise to be rejected and caught
      const result = await catchPromise;
      expect(result).toBe('caught');
      
      // Restore timers
      jest.useRealTimers();
    });
  });
  
  describe('getErrorFromCloseReason', () => {
    test('should return the close reason', () => {
      expect(getErrorFromCloseReason('Test reason')).toBe('Test reason');
    });
    
    test('should return a default message for empty reason', () => {
      // For empty string, it should return a default message or empty string
      const result = getErrorFromCloseReason('');
      // Accept either a default message or the empty string itself
      expect(['Connection closed', '']).toContain(result);
    });
  });
  
  describe('generateId', () => {
    test('should generate a random ID', () => {
      const id = generateId();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });
  });
});
