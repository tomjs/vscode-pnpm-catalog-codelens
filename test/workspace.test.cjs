'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mock, activate } = require('./helpers.cjs');

async function run() {
  // 1) template project with several pnpm-workspace.yaml: only the root one is used
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-catalog-ws-'));
    try {
      fs.mkdirSync(path.join(root, 'templates', 'foo', 'app'), { recursive: true });
      fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\ncatalog:\n  react: ^18.0.0\n');
      fs.writeFileSync(path.join(root, 'templates', 'foo', 'pnpm-workspace.yaml'), 'packages:\n  - "."\ncatalog:\n  decoy: 1.0.0\n');
      const pkgPath = path.join(root, 'templates', 'foo', 'app', 'package.json');
      fs.writeFileSync(pkgPath, JSON.stringify({ name: 'app', dependencies: { vue: '^3.4.0' } }, null, 2));

      const { addToCatalog, provider } = await activate(root);
      const doc = await mock.workspace.openTextDocument(mock.Uri.file(pkgPath));
      mock.workspace.textDocuments = [doc];
      const lens = provider.provideCodeLenses(doc)
        .find(l => l.command.title === '+catalog' && l.command.arguments[0].packageName === 'vue');
      await addToCatalog(lens.command.arguments[0]);

      assert.ok(fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8').includes('vue: ^3.4.0'), 'root yaml updated');
      assert.ok(
        fs.readFileSync(path.join(root, 'templates', 'foo', 'pnpm-workspace.yaml'), 'utf8').includes('decoy: 1.0.0')
        && !fs.readFileSync(path.join(root, 'templates', 'foo', 'pnpm-workspace.yaml'), 'utf8').includes('vue'),
        'nested yaml untouched',
      );
    }
    finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // 2) unsaved yaml edits are respected: the open (dirty) buffer is edited and saved
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-catalog-ws-'));
    try {
      fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'catalog:\n  react: ^18.0.0\n');
      const pkgPath = path.join(root, 'app', 'package.json');
      fs.mkdirSync(path.dirname(pkgPath), { recursive: true });
      fs.writeFileSync(pkgPath, JSON.stringify({ name: 'app', dependencies: { vue: '^3.4.0' } }, null, 2));

      const { addToCatalog, provider } = await activate(root);
      const pkgDoc = await mock.workspace.openTextDocument(mock.Uri.file(pkgPath));
      const yamlDoc = await mock.workspace.openTextDocument(mock.Uri.file(path.join(root, 'pnpm-workspace.yaml')));
      yamlDoc.text = 'catalog:\n  react: ^18.1.0\n# unsaved comment\n'; // dirty buffer, not on disk
      mock.workspace.textDocuments = [pkgDoc, yamlDoc];

      const lens = provider.provideCodeLenses(pkgDoc)
        .find(l => l.command.title === '+catalog' && l.command.arguments[0].packageName === 'vue');
      await addToCatalog(lens.command.arguments[0]);

      const onDisk = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
      assert.ok(onDisk.includes('# unsaved comment'), 'dirty buffer content preserved');
      assert.ok(onDisk.includes('vue: ^3.4.0'), 'entry added to buffer content');
      assert.ok(onDisk.includes('react: ^18.1.0'), 'unsaved version kept, not the on-disk one');
    }
    finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // 3) orphan catalog reference: asks for a version pre-filled from node_modules
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-catalog-ws-'));
    try {
      fs.mkdirSync(path.join(root, 'app'), { recursive: true });
      fs.mkdirSync(path.join(root, 'node_modules', 'vue-router'), { recursive: true });
      fs.mkdirSync(path.join(root, 'node_modules', '@vue', 'test-utils'), { recursive: true });
      fs.writeFileSync(path.join(root, 'node_modules', 'vue-router', 'package.json'), JSON.stringify({ name: 'vue-router', version: '4.4.0' }));
      fs.writeFileSync(path.join(root, 'node_modules', '@vue', 'test-utils', 'package.json'), JSON.stringify({ name: '@vue/test-utils', version: '2.4.6' }));
      fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'catalog:\n  react: ^18.0.0\n');
      const pkgPath = path.join(root, 'app', 'package.json');
      fs.writeFileSync(pkgPath, JSON.stringify({
        name: 'app',
        dependencies: { 'vue-router': 'catalog:' },
        devDependencies: { '@vue/test-utils': 'catalog:dev' },
      }, null, 2));

      const { addToCatalog, provider } = await activate(root);
      const doc = await mock.workspace.openTextDocument(mock.Uri.file(pkgPath));
      mock.workspace.textDocuments = [doc];
      const lens = (title, name) => provider.provideCodeLenses(doc)
        .find(l => l.command.title === title && l.command.arguments[0].packageName === name);
      const yamlPath = path.join(root, 'pnpm-workspace.yaml');

      // same target: version asked, entry created, reference kept
      let asked;
      const originalInput = mock.window.showInputBox;
      mock.window.showInputBox = async (options) => {
        asked = options.value;
        return '4.4.0';
      };
      await addToCatalog(lens('✓ catalog', 'vue-router').command.arguments[0]);
      assert.equal(asked, '4.4.0', 'pre-filled from node_modules');
      assert.ok(fs.readFileSync(yamlPath, 'utf8').includes('vue-router: 4.4.0'), 'entry created');
      assert.equal(JSON.parse(doc.text).dependencies['vue-router'], 'catalog:', 'reference kept');

      // cancel: nothing happens
      mock.window.showInputBox = async () => undefined;
      const before = fs.readFileSync(yamlPath, 'utf8');
      await addToCatalog(lens('✓ catalogs:dev', '@vue/test-utils').command.arguments[0]);
      assert.equal(fs.readFileSync(yamlPath, 'utf8'), before, 'cancel aborts');
      assert.equal(JSON.parse(doc.text).devDependencies['@vue/test-utils'], 'catalog:dev');

      // scoped package prefill
      mock.window.showInputBox = async (options) => {
        asked = options.value;
        return options.value;
      };
      await addToCatalog(lens('✓ catalogs:dev', '@vue/test-utils').command.arguments[0]);
      assert.equal(asked, '2.4.6', 'scoped package pre-filled');
      mock.window.showInputBox = originalInput;
    }
    finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

module.exports = { run };
