'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mock, activate } = require('./helpers.cjs');

const CREATE = 'Create';

function fixture(yaml, pkg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-catalog-cmd-'));
  if (yaml !== null)
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), yaml);
  const pkgPath = path.join(root, 'app', 'package.json');
  fs.mkdirSync(path.dirname(pkgPath), { recursive: true });
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  return { root, pkgPath };
}

async function open(root, pkgPath) {
  const { addToCatalog, provider } = await activate(root);
  const doc = await mock.workspace.openTextDocument(mock.Uri.file(pkgPath));
  mock.workspace.textDocuments = [doc];
  const lens = (title, name) => provider.provideCodeLenses(doc)
    .find(l => l.command.title === title && l.command.arguments[0].packageName === name);
  return { doc, addToCatalog, lens };
}

async function run() {
  // 1) add to default catalog: yaml entry + package.json ref, saved to disk
  {
    const pkg = { name: 'app', dependencies: { vue: '^3.4.0' } };
    const { root, pkgPath } = fixture('catalog:\n  react: ^18.0.0\n', pkg);
    const { doc, addToCatalog, lens } = await open(root, pkgPath);
    await addToCatalog(lens('+catalog', 'vue').command.arguments[0]);
    const yaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    assert.ok(yaml.includes('vue: ^3.4.0'), 'yaml gets the entry');
    assert.equal(JSON.parse(doc.text).dependencies.vue, 'catalog:', 'package.json ref replaced');
    assert.equal(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dependencies.vue, 'catalog:', 'auto-saved to disk');
  }

  // 2) section-mapped named catalog
  {
    const pkg = { name: 'app', devDependencies: { vitest: '^1.6.0' } };
    const { root, pkgPath } = fixture('packages:\n  - "app"\n', pkg);
    const { doc, addToCatalog, lens } = await open(root, pkgPath);
    await addToCatalog(lens('+catalogs:dev', 'vitest').command.arguments[0]);
    const yaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    assert.ok(yaml.includes('vitest: ^1.6.0'), 'entry under catalogs.dev');
    assert.equal(JSON.parse(doc.text).devDependencies.vitest, 'catalog:dev');
  }

  // 3) version conflict: pick catalog version / pick package version / cancel
  {
    const pkg = { name: 'app', dependencies: { react: '18.2.0' } };
    const { root, pkgPath } = fixture('catalog:\n  react: ^18.0.0\n', pkg);
    const { doc, addToCatalog, lens } = await open(root, pkgPath);

    mock._hooks.state.pickQueue.push({ version: '^18.0.0' });
    await addToCatalog(lens('+catalog', 'react').command.arguments[0]);
    assert.ok(fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8').includes('react: ^18.0.0'), 'catalog version kept');
    assert.equal(JSON.parse(doc.text).dependencies.react, 'catalog:');

    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'app', dependencies: { react: '19.0.0' } }, null, 2));
    doc.text = fs.readFileSync(pkgPath, 'utf8');
    mock._hooks.state.pickQueue.push({ version: '19.0.0' });
    await addToCatalog(lens('+catalog', 'react').command.arguments[0]);
    assert.ok(fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8').includes('react: 19.0.0'), 'package version wins');

    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'app', dependencies: { react: '20.0.0' } }, null, 2));
    doc.text = fs.readFileSync(pkgPath, 'utf8');
    mock._hooks.state.pickQueue.push(undefined);
    await addToCatalog(lens('+catalog', 'react').command.arguments[0]);
    assert.ok(fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8').includes('react: 19.0.0'), 'cancel keeps yaml');
    assert.equal(JSON.parse(doc.text).dependencies.react, '20.0.0', 'cancel keeps package.json');
  }

  // 4) switching a cataloged dep resolves the real version from the source catalog
  {
    const pkg = { name: 'app', devDependencies: { typescript: 'catalog:dev' } };
    const { root, pkgPath } = fixture('catalogs:\n  dev:\n    typescript: ~5.9.3\n', pkg);
    const { doc, addToCatalog, lens } = await open(root, pkgPath);
    await addToCatalog(lens('+catalog', 'typescript').command.arguments[0]);
    const yaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    assert.ok(yaml.includes('typescript: ~5.9.3'), 'real version moved, not the catalog: literal');
    assert.equal(JSON.parse(doc.text).devDependencies.typescript, 'catalog:');
  }

  // 5) clicking the current (✓) button is a no-op
  {
    const pkg = { name: 'app', dependencies: { react: 'catalog:' } };
    const { root, pkgPath } = fixture('catalog:\n  react: ^18.0.0\n', pkg);
    const { doc, addToCatalog, lens } = await open(root, pkgPath);
    await addToCatalog(lens('✓ catalog', 'react').command.arguments[0]);
    assert.equal(fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'), 'catalog:\n  react: ^18.0.0\n', 'yaml untouched');
    assert.equal(JSON.parse(doc.text).dependencies.react, 'catalog:');
  }

  // 6) restore: yaml entry removed, direct version written back
  {
    const pkg = { name: 'app', dependencies: { react: 'catalog:' } };
    const { root, pkgPath } = fixture('catalog:\n  react: ^18.0.0\n', pkg);
    const { doc, addToCatalog, lens } = await open(root, pkgPath);
    await addToCatalog(lens('Restore version', 'react').command.arguments[0]);
    assert.ok(!fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8').includes('react'), 'entry removed');
    assert.equal(JSON.parse(doc.text).dependencies.react, '^18.0.0', 'version restored');
  }

  // 7) +catalogs:* picker: custom first, built-ins excluded, existing listed
  {
    const pkg = { name: 'app', dependencies: { vue: '^3.4.0' } };
    const { root, pkgPath } = fixture('catalogs:\n  dev:\n    vitest: ^1.0.0\n  tools:\n    prettier: ^3.0.0\n', pkg);
    const { addToCatalog, lens } = await open(root, pkgPath);

    let picked;
    const originalQuickPick = mock.window.showQuickPick;
    mock.window.showQuickPick = async (items) => {
      picked = items.map(i => i.catalogName);
      return undefined;
    };
    await addToCatalog(lens('+catalogs:*', 'vue').command.arguments[0]);
    mock.window.showQuickPick = originalQuickPick;
    assert.deepEqual(picked, ['__custom__', 'tools'], 'custom first, dev excluded, tools listed');
  }

  // 8) custom catalog name validation
  {
    const pkg = { name: 'app', dependencies: { vue: '^3.4.0' } };
    const { root, pkgPath } = fixture('catalogs:\n  tools:\n    prettier: ^3.0.0\n', pkg);
    const { addToCatalog, lens } = await open(root, pkgPath);
    mock._hooks.state.pickQueue.push({ label: 'custom', catalogName: '__custom__' });
    let validate;
    const originalInput = mock.window.showInputBox;
    mock.window.showInputBox = async (options) => {
      validate = options.validateInput;
      return undefined;
    };
    await addToCatalog(lens('+catalogs:*', 'vue').command.arguments[0]);
    mock.window.showInputBox = originalInput;
    assert.match(validate(''), /empty/);
    assert.match(validate('dev'), /reserved/);
    assert.match(validate('default'), /reserved/);
    assert.match(validate('bad name!'), /letters/);
    assert.match(validate('tools'), /already exists/);
    assert.equal(validate('ui'), undefined);
  }

  // 9) missing yaml: cancel creates nothing, confirm creates file with the entry
  {
    const pkg = { name: 'app', dependencies: { vue: '^3.4.0' } };
    const { root, pkgPath } = fixture(null, pkg);
    const { doc, addToCatalog, lens } = await open(root, pkgPath);
    const yamlPath = path.join(root, 'pnpm-workspace.yaml');

    mock._hooks.state.msgQueue.push('Cancel');
    await addToCatalog(lens('+catalog', 'vue').command.arguments[0]);
    assert.ok(!fs.existsSync(yamlPath), 'cancel creates nothing');
    assert.equal(JSON.parse(doc.text).dependencies.vue, '^3.4.0', 'cancel keeps package.json');

    mock._hooks.state.msgQueue.push(CREATE);
    await addToCatalog(lens('+catalog', 'vue').command.arguments[0]);
    assert.equal(fs.readFileSync(yamlPath, 'utf8'), 'catalog:\n  vue: ^3.4.0\n', 'confirm creates the file');
    assert.equal(JSON.parse(doc.text).dependencies.vue, 'catalog:');
  }

  // 10) named catalog on a fresh yaml
  {
    const pkg = { name: 'app', devDependencies: { vitest: '^1.6.0' } };
    const { root, pkgPath } = fixture(null, pkg);
    const { addToCatalog, lens } = await open(root, pkgPath);
    mock._hooks.state.msgQueue.push(CREATE);
    await addToCatalog(lens('+catalogs:dev', 'vitest').command.arguments[0]);
    const yaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    assert.ok(yaml.includes('catalogs:'), 'named section created');
    assert.ok(yaml.includes('vitest: ^1.6.0'));
  }
}

module.exports = { run };
