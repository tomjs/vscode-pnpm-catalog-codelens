'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mock, activate } = require('./helpers.cjs');

const DOCS_STYLE = [
  'catalog:',
  '  react: ^16.14.0',
  '  react-dom: ^16.14.0',
  '',
  'catalogs:',
  '  # 可以通过 "catalog:react17" 引用',
  '  react17:',
  '    react: ^17.0.2',
  '    react-dom: ^17.0.2',
  '',
  '  # 可以通过 "catalog:react18" 引用',
  '  react18:',
  '    react: ^18.2.0',
  '    react-dom: ^18.2.0',
  '',
].join('\n');

async function addTo(root, pkgPath, title, pkgName, interact) {
  const { addToCatalog, provider } = await activate(root);
  if (interact)
    interact();
  const doc = await mock.workspace.openTextDocument(mock.Uri.file(pkgPath));
  mock.workspace.textDocuments = [doc];
  const lens = provider.provideCodeLenses(doc)
    .find(l => l.command.title === title && l.command.arguments[0].packageName === pkgName);
  await addToCatalog(lens.command.arguments[0]);
  return fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
}

function fixture(yaml, pkg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-catalog-style-'));
  if (yaml !== null)
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), yaml);
  const pkgPath = path.join(root, 'app', 'package.json');
  fs.mkdirSync(path.dirname(pkgPath), { recursive: true });
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  return { root, pkgPath };
}

async function run() {
  // 1) fresh named catalog: no generated comment
  {
    const { root, pkgPath } = fixture(null, { name: 'app', devDependencies: { vitest: '^1.6.0' } });
    const { addToCatalog, provider } = await activate(root);
    const doc = await mock.workspace.openTextDocument(mock.Uri.file(pkgPath));
    mock.workspace.textDocuments = [doc];
    const lens = provider.provideCodeLenses(doc)
      .find(l => l.command.title === '+catalogs:*' && l.command.arguments[0].packageName === 'vitest');
    mock._hooks.state.msgQueue.push('Create');
    mock._hooks.state.pickQueue.push({ label: 'custom', catalogName: '__custom__' });
    mock._hooks.state.inputQueue.push('react17');
    await addToCatalog(lens.command.arguments[0]);
    const yaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    assert.equal(yaml, 'catalogs:\n  react17:\n    vitest: ^1.6.0\n');
  }

  // 2) existing docs-style file: user comments and blank lines preserved, nothing new generated
  {
    const { root, pkgPath } = fixture(DOCS_STYLE, { name: 'app', devDependencies: { eslint: '^10.10.0' } });
    const yaml = await addTo(root, pkgPath, '+catalogs:dev', 'eslint');
    assert.equal((yaml.match(/# 可以通过/g) || []).length, 2, 'existing comments kept');
    assert.ok(!yaml.includes('##'), 'no duplicated comment markers');
    assert.ok(!yaml.includes('# Reference via'), 'no comment generated for the new catalog');
    assert.ok(yaml.includes('\n\n  dev:'), 'blank line before the new catalog');
    assert.ok(yaml.indexOf('react18:') < yaml.indexOf('dev:'), 'append after existing catalogs');
  }

  // 3) default-only file gets a blank line between catalog: and catalogs:
  {
    const { root, pkgPath } = fixture('catalog:\n  react: ^16.14.0\n', { name: 'app', devDependencies: { eslint: '^10.10.0' } });
    const yaml = await addTo(
      root,
      pkgPath,
      '+catalogs:*',
      'eslint',
      () => {
        mock._hooks.state.pickQueue.push({ label: 'custom', catalogName: '__custom__' });
        mock._hooks.state.inputQueue.push('tools');
      },
    );
    assert.equal(
      yaml,
      'catalog:\n  react: ^16.14.0\n\ncatalogs:\n  tools:\n    eslint: ^10.10.0\n',
      'blank line between catalog and catalogs blocks',
    );
  }

  // 4) user-written comments are never overwritten
  {
    const { root, pkgPath } = fixture('catalogs:\n  # my own tools catalog\n  tools:\n    prettier: ^3.0.0\n', { name: 'app', devDependencies: { eslint: '^10.10.0' } });
    const yaml = await addTo(root, pkgPath, '+catalogs:dev', 'eslint');
    assert.ok(yaml.includes('# my own tools catalog'), 'user comment intact');
    assert.ok(!yaml.includes('# Reference via'), 'no comment generated');
    assert.ok(yaml.includes('\n\n  dev:'), 'blank line before the new catalog');
  }
}

module.exports = { run };
