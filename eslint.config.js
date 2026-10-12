// Flat config (ESLint 9). Same rules as homebridge-tahoma so both plugins read alike.
const js = require('@eslint/js');
const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

const style = {
    'quotes': ['warn', 'single'],
    'indent': ['warn', 4, { SwitchCase: 1 }],
    'semi': ['warn', 'always'],
    'comma-dangle': ['warn', 'always-multiline'],
    'dot-notation': 'off',
    'eqeqeq': 'warn',
    'curly': ['warn', 'all'],
    'brace-style': ['warn'],
    'prefer-arrow-callback': ['warn'],
    'max-len': ['warn', 140],
    'comma-spacing': ['error'],
    'no-multi-spaces': ['warn', { ignoreEOLComments: true }],
    'lines-between-class-members': ['warn', 'always', { exceptAfterSingleLine: true }],
};

module.exports = [
    {
        ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
    },
    js.configs.recommended,
    {
        files: ['src/**/*.ts', 'test/**/*.ts'],
        languageOptions: {
            parser: tsParser,
            ecmaVersion: 2020,
            sourceType: 'module',
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
        },
        rules: {
            ...tsPlugin.configs['eslint-recommended'].overrides?.[0]?.rules,
            ...tsPlugin.configs.recommended.rules,
            ...style,
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true }],
        },
    },
    {
        // Tests read better with long literals (frame dumps, fixtures) on one line.
        files: ['test/**/*.ts'],
        rules: {
            'max-len': 'off',
            'brace-style': 'off',
        },
    },
    {
        // The CLI is a terminal program: printing is its job.
        files: ['src/cli.ts', 'src/cli/**/*.ts'],
        rules: {
            'no-console': 'off',
        },
    },
    {
        files: ['src/**/*.ts'],
        ignores: ['src/cli.ts', 'src/cli/**/*.ts'],
        rules: {
            'no-console': ['warn'],
        },
    },
];
