import { defineConfig } from 'tsdown';

export default defineConfig((options) => {
  return {
    entry: ['src/index.ts'],
    format: ['cjs'],
    target: 'node14',
    deps: {
      neverBundle: ['vscode'],
      alwaysBundle: id => !id.startsWith('vscode') && !id.startsWith('node:'),
    },
    inputOptions: {
      resolve: {
        mainFields: ['module', 'main'],
      },
    },
    clean: true,
    sourcemap: !!options.watch,
    fixedExtension: false,
  };
});
