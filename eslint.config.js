import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'public/data'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: globals.browser },
    rules: {
      // The randomness of this project is its entire product. Math.random is not a
      // CSPRNG and is never acceptable here — src/random.ts is the only source.
      'no-restricted-globals': [
        'error',
        {
          name: 'Math.random',
          message: 'Use randomBelow() from src/random.ts.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.name='Math'][property.name='random']",
          message:
            'Math.random is not a CSPRNG — use randomBelow() from src/random.ts.',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.{ts,mjs}', '*.ts', '*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
)
