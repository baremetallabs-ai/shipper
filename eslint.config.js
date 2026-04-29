import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: [
      'dist/',
      'out/',
      'packages/*/dist/',
      'packages/*/.astro/',
      'packages/*/out/',
      'node_modules/',
      'coverage/',
      '**/*.config.*',
    ],
  },
  eslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: [
          './packages/cli/tsconfig.eslint.json',
          './packages/core/tsconfig.eslint.json',
          './packages/mcp/tsconfig.eslint.json',
          './packages/desktop/tsconfig.eslint.node.json',
          './packages/desktop/tsconfig.eslint.web.json',
        ],
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs['strict-type-checked'].rules,

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowNumber: true,
          allowBoolean: true,
        },
      ],
      '@typescript-eslint/restrict-plus-operands': [
        'error',
        {
          allowNumberAndString: true,
        },
      ],
      // Phase 3: Targeted rules (#280)
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          disallowTypeAnnotations: false,
        },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: 'error',

      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    files: ['packages/**/*.{ts,tsx}'],
    ignores: ['packages/core/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@dnsquared/shipper-core/*'],
              message:
                'Import from @dnsquared/shipper-core. Deep subpaths are not part of the public API.',
            },
            {
              group: ['**/core/src/**', '**/packages/core/src/**'],
              message:
                'Do not reach into packages/core/src from outside the core package. Import from @dnsquared/shipper-core.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='vi'][callee.property.name=/^(mock|doMock|importActual|importMock)$/] > Literal:first-child[value=/(@dnsquared\\/shipper-core\\/|core\\/src\\/|packages\\/core\\/src\\/)/]",
          message:
            'Vitest module strings must use @dnsquared/shipper-core, not deep core paths or subpaths.',
        },
      ],
    },
  },
  {
    files: ['packages/**/*.{js,mjs,cjs}'],
    ignores: ['packages/core/**/*.{js,mjs,cjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@dnsquared/shipper-core/*'],
              message:
                'Import from @dnsquared/shipper-core. Deep subpaths are not part of the public API.',
            },
            {
              group: ['**/core/src/**', '**/packages/core/src/**'],
              message:
                'Do not reach into packages/core/src from outside the core package. Import from @dnsquared/shipper-core.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='vi'][callee.property.name=/^(mock|doMock|importActual|importMock)$/] > Literal:first-child[value=/(@dnsquared\\/shipper-core\\/|core\\/src\\/|packages\\/core\\/src\\/)/]",
          message:
            'Vitest module strings must use @dnsquared/shipper-core, not deep core paths or subpaths.',
        },
      ],
    },
  },
  {
    files: ['packages/core/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['packages/core/**/*.{js,mjs,cjs}'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['packages/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        document: 'readonly',
        Event: 'readonly',
        HTMLElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLInputElement: 'readonly',
        KeyboardEvent: 'readonly',
        navigator: 'readonly',
        window: 'readonly',
      },
    },
  },
];
