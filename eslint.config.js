// ESLint flat config: the recommended JavaScript rules plus typescript-eslint's type-aware rules.
// Formatting is left to Prettier (`npm run format`).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Explicit, readable conversions in template strings (String(n)) are preferred over implicit ones.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: false }],
      // Tests use non-null assertions on values the test itself just created.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // node:test's describe/it/before/after return promises that the test runner itself awaits.
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['describe', 'it', 'before', 'after', 'test'] }] },
      ],
    },
  },
  {
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
