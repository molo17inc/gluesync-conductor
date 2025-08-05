module.exports = {
  root: true,
  ignorePatterns: [
    '.yarn',
    'dist',
    'build',
    'lib',
    'nodejs',
    'coverage',
    'node_modules',
    'babel.config.js',
    'jest.config.js',
    'jest-mongodb-config.js',
    '*.eslintrc.cjs',
    '*.eslintrc.js',
    'src/locales/**/*.d.ts',
    'lingui.config.ts',
  ],

  extends: [
    'airbnb-base',
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:functional/external-typescript-recommended',
    'plugin:functional/lite',
    'plugin:functional/stylistic',
    'plugin:prettier/recommended',
  ],

  plugins: ['functional'],

  rules: {
    'arrow-body-style': [1, 'as-needed'],
    'no-case-declarations': 0,
    'no-console': 0,
    'no-unused-expressions': [
      2,
      { allowTernary: true, allowShortCircuit: true },
    ],
    'no-shadow': 0,
    'no-underscore-dangle': 0,

    'functional/no-return-void': 0,
    'functional/no-throw-statements': 0,

    'import/named': 0,
    // 'import/order': 0,
    // 'import/no-cycle': 0,
    'import/extensions': 0,
    // 'import/no-duplicates': 0,
    'import/no-unresolved': 0,
    // 'import/no-self-import': 0,
    // 'import/no-named-as-default': 0,
    // 'import/no-relative-packages': 0,
    // 'import/no-useless-path-segments': 0,
    'import/no-extraneous-dependencies': 0,
    // 'import/no-named-as-default-member': 0,
    // 'default-case': 0,
    'import/prefer-default-export': 0,
    // 'functional/prefer-tacit': 0,
    // 'consistent-return': 0,
    // 'no-useless-catch': 0,
    // 'prefer-regex-literals': 0,
    // 'no-bitwise': 0,

    '@typescript-eslint/no-explicit-any': 0,
    'functional/prefer-immutable-types': 0,
    'functional/immutable-data': 0,
    'no-param-reassign': 0,
    'functional/no-let': 0,
    'functional/no-mixed-types': 0,
  },

  overrides: [
    // Add into the extender file
    // {
    //   files: ['*.ts'],
    //   parserOptions: {
    //     project: ['./tsconfig.json'],
    //   },
    // },
    {
      files: ['**/*.ts'],
      plugins: ['deprecation'],
      rules: {
        '@typescript-eslint/prefer-readonly-parameter-types': 0,

        'deprecation/deprecation': 1,
      },
    },
    {
      files: ['**/*.spec.ts'],
      rules: {
        'functional/no-let': 0,
      },
    },
    {
      files: ['**/schema/generated/index.ts'],
      rules: {
        'no-use-before-define': 0,
        '@typescript-eslint/ban-types': 0,
        '@typescript-eslint/no-explicit-any': 0,
        'functional/prefer-immutable-types': 0,
        '@typescript-eslint/no-unused-vars': 0,
      },
    },
  ],
};
