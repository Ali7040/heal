// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      // Match tsc's noUnusedParameters convention: a leading _ means "required by
      // the contract, deliberately unused here".
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The contracts are the product — a loose type here leaks into every consumer.
    files: ['packages/core/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
