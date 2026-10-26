module.exports = {
  root: true,
  extends: '../../base-ts.eslintrc.cjs',
  overrides: [
    {
      files: ['**/*.ts'],
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: __dirname,
      },
    },
    {
      // Test doubles record the calls made to them and specs set process.env,
      // so the immutability rules only get in the way here
      files: ['src/**/*.spec.ts', 'src/testing/**/*.ts'],
      rules: {
        'functional/immutable-data': 'off',
        'functional/functional-parameters': 'off',
        'functional/prefer-immutable-types': 'off',
        'functional/no-mixed-types': 'off',
      },
    },
  ],
};
