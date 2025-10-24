module.exports = {
  root: true,
  extends: '../../base-ts.eslintrc.cjs',
  parserOptions: {
    project: ['./tsconfig.json'],
    tsconfigRootDir: __dirname,
  },
};
