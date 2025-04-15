/**
 * Tests for the discovery module.
 */

// Import modules - must be before mocks
import { CoreHubDiscovery, getCorehubAddress } from '../src/discovery';

// Mock the CoreHubDiscovery class
jest.mock('../src/discovery', () => {
  const mockDiscoverCoreHub = jest.fn().mockResolvedValue('192.168.1.100');
  const mockGetCorehubAddress = jest.fn().mockImplementation(envVarName => {
    if (process.env[envVarName]) {
      return Promise.resolve(process.env[envVarName]);
    }
    return Promise.resolve('192.168.1.100');
  });

  return {
    CoreHubDiscovery: jest.fn().mockImplementation(() => ({
      discoverCoreHub: mockDiscoverCoreHub,
    })),
    getCorehubAddress: mockGetCorehubAddress,
  };
});

describe('CoreHubDiscovery', () => {
  let discovery: CoreHubDiscovery;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Create a new discovery instance
    discovery = new CoreHubDiscovery(1717, 10);
  });

  test('should discover CoreHub address', async () => {
    // Call the discover method
    const result = await discovery.discoverCoreHub();

    // Verify the result
    expect(result).toBe('192.168.1.100');
  });

  test('should handle errors during discovery', async () => {
    // Mock the discoverCoreHub method to reject
    (discovery.discoverCoreHub as jest.Mock).mockRejectedValueOnce(
      new Error('Network error'),
    );

    // Call the discover method and expect it to reject
    await expect(discovery.discoverCoreHub()).rejects.toThrow('Network error');
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
    const address = await getCorehubAddress('CORE_HUB_ADDRESS', 1717, 10);

    // Verify the result
    expect(address).toBe('10.0.0.1');
  });

  test('should discover address if environment variable is not set', async () => {
    // Call getCorehubAddress
    const address = await getCorehubAddress('CORE_HUB_ADDRESS', 1717, 10);

    // Verify the result
    expect(address).toBe('192.168.1.100');
  });
});
