module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.tsx?$',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  // Use environment variable for timeout or default to 30000ms
  testTimeout: process.env.JEST_TIMEOUT
    ? parseInt(process.env.JEST_TIMEOUT)
    : 30000,
};
