const sharedGlobals = {
  AbortSignal: 'readonly', Blob: 'readonly', Buffer: 'readonly', console: 'readonly', crypto: 'readonly',
  document: 'readonly', fetch: 'readonly', FormData: 'readonly', HTMLDialogElement: 'readonly', Response: 'readonly',
  Intl: 'readonly', MutationObserver: 'readonly', process: 'readonly', queueMicrotask: 'readonly',
  setImmediate: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', structuredClone: 'readonly', URL: 'readonly',
  window: 'readonly'
};

export default [
  {
    ignores: ['dist/**', 'release/**', 'tmp/**', 'node_modules/**']
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: sharedGlobals
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error'
    },
    rules: {
      'constructor-super': 'error',
      'getter-return': 'error',
      'no-class-assign': 'error',
      'no-const-assign': 'error',
      'no-dupe-args': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-else-if': 'error',
      'no-dupe-keys': 'error',
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-new-native-nonconstructor': 'error',
      'no-obj-calls': 'error',
      'no-promise-executor-return': 'error',
      'no-redeclare': 'error',
      'no-self-assign': 'error',
      'no-setter-return': 'error',
      'no-this-before-super': 'error',
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-unreachable-loop': 'error',
      'no-unsafe-finally': 'error',
      'no-unused-private-class-members': 'error',
      'no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
      'valid-typeof': 'error'
    }
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...sharedGlobals, module: 'readonly', require: 'readonly' }
    }
  }
];
