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
  ],
};
