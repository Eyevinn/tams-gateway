const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const prettierRecommended = require('eslint-plugin-prettier/recommended');
const globals = require('globals');

module.exports = tseslint.config(
  // Vendored third-party minified asset — never linted (huge single-line file).
  { ignores: ['node_modules', 'coverage', '.husky', 'src/api/ui/vendor/**'] },
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.es2021 }
    }
  },
  // The inspector client script runs in the browser, not Node.
  {
    files: ['src/api/ui/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser }
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
