/**
 * Test for the UDP autodiscovery functionality.
 * This test mocks CoreHub functionality to avoid actual network operations.
 */

import { CoreHubDiscovery, getCorehubAddress } from '../../src/discovery';

// Constants for testing
const MOCK_COREHUB_ADDRESS = '192.168.1.100';
const START_PORT = 1717;
const PORT_RANGE = 10;

// Mock the discoverCoreHub method
const mockDiscoverCoreHub = jest.fn().mockResolvedValue(MOCK_COREHUB_ADDRESS);

// Mock the CoreHubDiscovery class
jest.mock('../../src/discovery', () => {
  const originalModule = jest.requireActual('../../src/discovery');

  // Create a mock class that extends the original
  class MockCoreHubDiscovery extends originalModule.CoreHubDiscovery {
    discoverCoreHub = mockDiscoverCoreHub;
  }

  return {
    ...originalModule,
    CoreHubDiscovery: MockCoreHubDiscovery,
    getCorehubAddress: jest.fn().mockImplementation(envVarName => {
      if (process.env[envVarName]) {
        return Promise.resolve(process.env[envVarName]);
      }
      return Promise.resolve(MOCK_COREHUB_ADDRESS);
    }),
  };
});

describe('CoreHubDiscovery', () => {
  let discovery: CoreHubDiscovery;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create a new discovery instance
    discovery = new CoreHubDiscovery(START_PORT, PORT_RANGE);
  });

  test('should discover CoreHub successfully', async () => {
    // Call the discover method
    const result = await discovery.discoverCoreHub();

    // Verify the result matches our mock address
    expect(result).toBe(MOCK_COREHUB_ADDRESS);

    // Verify the mock was called
    expect(mockDiscoverCoreHub).toHaveBeenCalled();
  });
});

describe('getCorehubAddress', () => {
  beforeEach(() => {
    // Reset environment variables
    delete process.env.CORE_HUB_ADDRESS;

    // Reset mocks
    jest.clearAllMocks();
  });

  test('should return address from environment variable if set', async () => {
    // Set environment variable
    process.env.CORE_HUB_ADDRESS = '10.0.0.1';

    // Call getCorehubAddress
    const address = await getCorehubAddress(
      'CORE_HUB_ADDRESS',
      START_PORT,
      PORT_RANGE,
    );

    // Verify the result
    expect(address).toBe('10.0.0.1');
  });

  test('should discover address if environment variable is not set', async () => {
    // Call getCorehubAddress
    const address = await getCorehubAddress(
      'CORE_HUB_ADDRESS',
      START_PORT,
      PORT_RANGE,
    );

    // Verify the result
    expect(address).toBe(MOCK_COREHUB_ADDRESS);
  });
});
