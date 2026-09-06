# AGENTS.md

VS Code extension that moves dependency versions from `package.json` into the
`catalog:` section of `pnpm-workspace.yaml` and replaces them with `catalog:`
references, plus a CodeLens "add to catalog" UI. Modeled on
[`vscode-versionlens`](https://github.com/versionlens/vscode-versionlens) (local checkout at `/Users/tom/Work/github/vscode-versionlens`).

## Package manager & toolchain

- Use **pnpm** (pinned `pnpm@10.34.5`). Output is **CommonJS** (`"type": "commonjs"`, tsdown target `node14`).
- Bundle with **tsdown** (`tsdown.config.mts`): entry `src/index.ts`, `neverBundle: ['vscode']`. Built file: `dist/index.js` (`package.json` `main`).

## Commands

| Command      | What it does                                                                  |
| ------------ | ----------------------------------------------------------------------------- |
| `pnpm dev`   | Runs `dev:vsd` + `dev:dist` in parallel (watch mode) — run this for debugging |
| `pnpm build` | `vscode-dev` (codegen) then `tsdown --minify`                                 |
| `pnpm test`  | Builds, then runs the mocked-VSCode integration tests in `test/`              |
| `pnpm lint`  | `eslint --fix` (Antfu config via `@tomjs/eslint-config`)                      |

No typecheck script exists — run `npx tsc --noEmit` manually. Tests in `test/` execute `dist/index.js` under plain node with a minimal `vscode` API mock (`test/mocks/vscode.cjs`); they exercise the real command handlers, yaml edits, and file writes against temp fixtures. `pnpm test` rebuilds first, so dist is always fresh.

## Generated files — do NOT hand-edit

`src/vscode.d.ts`, `package.nls.json`, and `package.nls.*.json` are **generated** by the
`vscode-dev` CLI (`@tomjs/vscode-dev`).

- i18n source of truth is `locales/en.json` + `locales/zh-CN.json` (flat keystyle, i18n-ally, source language zh-CN).
- `src/vscode.d.ts` augments `vscode` with typed `UserCommand` (from `package.json` `contributes.commands`) and `I18nMessageType` (from nls keys). Adding a command or i18n key without running `vscode-dev` breaks type-checking of `commands.registerCommand(...)` and `i18n.t(...)`.
- Both are regenerated automatically by `pnpm dev` (watch) and `pnpm build`. After editing `package.json` `contributes` or `locales/*.json`, let the watcher regenerate before checking types.
- `.vscodeignore` excludes `src` and `locales` from the packaged VSIX, so runtime i18n relies on the generated `package.nls*.json`.

## Extension conventions

- `src/index.ts` is the single entry. `activate()` must call `initExtension(context)` from `@tomjs/vscode` before `i18n.t()` works (reads `package.nls*.json`).
- Localization strings go through `i18n.t('...')`; `package.json` `contributes` titles use `%key%` placeholders resolved from the nls files.
- To register the editor title-bar toggle: add a command to `contributes.commands` + `contributes.menus` `editor/title` (this is the "top-right icon" mechanism).
- CodeLens pattern to follow (from `vscode-versionlens`): a `CodeLensProvider` whose lens range sits at the dependency **name** position; keep a separate range for the **version** text to replace; give each lens a `command` (e.g. `catalog`, `catalog:dev`, `catalog:prod`, `catalog:peer`). Respect `editor.codeLens` being disabled.
- Toggle on/off should gate `provideCodeLenses` (return `[]` when off) and trigger `onDidChangeCodeLenses` to refresh.

## Git hooks (simple-git-hooks)

- `pre-commit` runs `lint-staged` (`eslint --fix` on staged files); `commit-msg` runs commitlint (`@tomjs/commitlint-config`) — **conventional commit messages required**.
- `prepare` installs the hooks; after `pnpm install` hooks are active.
