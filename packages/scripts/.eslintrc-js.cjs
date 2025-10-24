module.exports = {
  root: true,
  env: { node: true },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  extends: '../../base-js.eslintrc.cjs',
  ignorePatterns: ['!lib', 'lib/generated', 'src'],
};
