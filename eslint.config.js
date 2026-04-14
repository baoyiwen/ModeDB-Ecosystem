import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettierPlugin from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      'test/**',
      'templates/**',
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'data/**',
      'packages/**/dist/**',
      'packages/**/tsup.config.ts',
      // Colocated `tsc` emit under `src/` is not part of the TS program; linting it breaks projectService.
      'src/**/*.js',
      'src/**/*.js.map',
      'src/**/*.d.ts',
      'src/**/*.d.ts.map',
      'authoring/**/*.js',
      'authoring/**/*.js.map',
      'authoring/**/*.d.ts',
      'authoring/**/*.d.ts.map',
      'common/**/*.js',
      'common/**/*.js.map',
      'common/**/*.d.ts',
      'common/**/*.d.ts.map',
      'runtime/**/*.js',
      'runtime/**/*.js.map',
      'runtime/**/*.d.ts',
      'runtime/**/*.d.ts.map',
      'network/**/*.js',
      'network/**/*.js.map',
      'network/**/*.d.ts',
      'network/**/*.d.ts.map',
      'packages/**/src/**/*.js',
      'packages/**/src/**/*.js.map',
      'packages/**/src/**/*.d.ts',
      'packages/**/src/**/*.d.ts.map',
      'templates/**/*.js',
      'templates/**/*.js.map',
      'templates/**/*.d.ts',
      'templates/**/*.d.ts.map',
      'test/**/*.js',
      'test/**/*.js.map',
      'test/**/*.d.ts',
      'test/**/*.d.ts.map',
    ],
  },

  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tsparser,
      parserOptions: {
        projectService: {
          // No `**` in globs (typescript-eslint); one segment under scripts/ is enough here.
          allowDefaultProject: [
            '*.config.js',
            '*.config.mjs',
            '*.config.ts',
            'lint-staged.config.mjs',
            'scripts/*.mjs',
          ],
        },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      prettier: prettierPlugin,
    },
    rules: {
      ...tseslint.configs['recommended'].rules,
      ...prettierConfig.rules,
      'prettier/prettier': 'error',

      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      // Allow `import type` + value import from same module (pairs with consistent-type-imports).
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-require-imports': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
    },
  },

  {
    files: ['**/*.config.{js,mjs,cjs,ts}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
