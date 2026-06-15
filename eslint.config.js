const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const prettierRecommended = require('eslint-plugin-prettier/recommended');
const globals = require('globals');

module.exports = tseslint.config(
  { ignores: ['node_modules', 'coverage', '.husky'] },
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.es2021 }
    }
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierRecommended,
  {
    rules: {
      // CommonJS config files (eslint/jest/commitlint) legitimately use require().
      '@typescript-eslint/no-require-imports': 'off',
      // Delegate unused-detection to TypeScript (noUnusedLocals), which understands
      // `typeof Schema` usage of TypeBox consts; the lint rule reports false positives.
      '@typescript-eslint/no-unused-vars': 'off'
    }
  }
);
