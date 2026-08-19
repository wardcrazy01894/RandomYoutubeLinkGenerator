import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'public/data'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // ---------------------------------------------------------------------------
  // The Math.random ban. This project's entire product is an unbiased draw, so an
  // accidental Math.random is a P0 correctness bug, not a style issue.
  //
  // No `files` key: this applies to EVERY linted file. It previously sat inside the
  // src/**/*.ts block, which left scripts/lib/prefix.mjs — the Feistel sampler — and
  // every other script completely unguarded.
  //
  // The companion `no-restricted-globals: [{ name: 'Math.random' }]` that used to live
  // here was DEAD CONFIG: that rule matches bare global identifiers, and there is no
  // global named "Math.random", so it never fired once. It is removed rather than left
  // as decoration, because a guard that looks like a second layer is worse than an
  // honest single one.
  {
    // DO NOT set `no-restricted-syntax` in any later config block. Flat config is
    // later-wins PER RULE, so a block further down that defines this rule silently
    // deletes every selector below for the files it matches — which is precisely how
    // this guard came to cover only src/**/*.ts. Extend this array instead.
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // Math.random()
          selector:
            "MemberExpression[object.name='Math'][property.name='random']",
          message:
            'Math.random is not a CSPRNG. Use randomBelow() from src/random.ts, or randomInt() from node:crypto in scripts.',
        },
        {
          // Math['random']() — computed access sidesteps a property.name selector.
          selector:
            "MemberExpression[computed=true][object.name='Math'][property.value='random']",
          message:
            'Math.random is not a CSPRNG. Use randomBelow() from src/random.ts, or randomInt() from node:crypto in scripts.',
        },
        {
          // globalThis.Math.random / window.Math.random
          selector:
            "MemberExpression[object.property.name='Math'][property.name='random']",
          message:
            'Math.random is not a CSPRNG. Use randomBelow() from src/random.ts, or randomInt() from node:crypto in scripts.',
        },
        {
          // const M = Math  /  const { random } = Math — aliasing or destructuring the
          // Math object escapes every member-expression selector above.
          selector: "VariableDeclarator[init.name='Math']",
          message:
            'Do not alias or destructure Math — it defeats the Math.random ban. Reference Math members directly.',
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: globals.browser },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.{ts,mjs}', '*.ts', '*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
)
