'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mock, activate, lensTitlesByLine } = require('./helpers.cjs');

const PKG = JSON.stringify({
  name: 'app',
  dependencies: { react: '^18.2.0', aliased: 'npm:react@18.0.0' },
  devDependencies: { vitest: '^1.6.0', typescript: 'catalog:dev', linked: 'link:../lib' },
  peerDependencies: { 'react-dom': '^18.2.0' },
  optionalDependencies: { fsevents: '^2.3.3' },
}, null, 2);

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-catalog-provider-'));
  try {
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'catalog:\n  typescript: ~5.9.3\n');
    const pkgPath = path.join(root, 'package.json');
    fs.writeFileSync(pkgPath, PKG);

    const { provider, commands } = await activate(root, { enabled: false });
    const doc = await mock.workspace.openTextDocument(mock.Uri.file(pkgPath));
    mock.workspace.textDocuments = [doc];

    // The service starts disabled by default - no lenses until enabled.
    assert.equal(provider.provideCodeLenses(doc).length, 0, 'disabled by default');

    await commands['tomjs.pnpmCatalog.enable']();

    // Buttons per dependency, mapped to their dependency's own line.
    const titles = lensTitlesByLine(provider, doc);
    const lineOf = name => PKG.split('\n').findIndex(l => l.includes(`"${name}"`));

    assert.deepEqual(titles.get(`${lineOf('react')}:react`), ['+catalog', '+catalogs:prod', '+catalogs:*']);
    assert.deepEqual(titles.get(`${lineOf('vitest')}:vitest`), ['+catalog', '+catalogs:dev', '+catalogs:*']);
    assert.deepEqual(titles.get(`${lineOf('react-dom')}:react-dom`), ['+catalog', '+catalogs:peer', '+catalogs:*']);
    assert.deepEqual(titles.get(`${lineOf('fsevents')}:fsevents`), ['+catalog', '+catalogs:optional', '+catalogs:*']);
    // Already cataloged: checkmark state + restore button.
    assert.deepEqual(titles.get(`${lineOf('typescript')}:typescript`), ['+catalog', '✓ catalogs:dev', '+catalogs:*', 'Restore version']);
    // Protocol versions are skipped entirely.
    assert.ok(!titles.has(`${lineOf('aliased')}:aliased`));
    assert.ok(!titles.has(`${lineOf('linked')}:linked`));

    // Non-package.json documents never get lenses.
    const other = path.join(root, 'tsconfig.json');
    fs.writeFileSync(other, '{}');
    const otherDoc = await mock.workspace.openTextDocument(mock.Uri.file(other));
    assert.equal(provider.provideCodeLenses(otherDoc).length, 0);

    // Disabling hides all lenses; enabling brings them back.
    await commands['tomjs.pnpmCatalog.disable']();
    assert.equal(provider.provideCodeLenses(doc).length, 0);
    await commands['tomjs.pnpmCatalog.enable']();
    assert.ok(provider.provideCodeLenses(doc).length > 0);
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { run };
