/** Pure source/callback admission checks; no native executable or network access. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
module.exports.auditMaintainedSources = function auditMaintainedSources() {
  const ts = require('typescript');
  const directory = __dirname;
  const names = [
    'desktop-worker.ts',
    'cli-worker.ts',
    'renderer.ts',
    '../native-consent-proof.ts',
    'inspector-probe.cjs',
    'bootstrap.ts',
    'chrome-host.ts',
    'desktop-custody.ts',
    'command-custody.ts',
    'build-custody.ts',
  ];
  const sources = Object.fromEntries(
    names.map((name) => [name, fs.readFileSync(path.join(directory, name), 'utf8')])
  );
  for (const [name, text] of Object.entries(sources)) {
    assert(
      !/['"](?:[^'"]*\/)?\.dork\/[^'"]*\.(?:ts|js|cjs)['"]/.test(text),
      name + ': ignored runtime source import'
    );
    assert(
      !/native-artifact-(?:cli|desktop|inspector)/.test(text),
      name + ': retired source dependency'
    );
    const source = ts.createSourceFile(
      name,
      text,
      ts.ScriptTarget.Latest,
      true,
      name.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
    );
    assert.equal(source.parseDiagnostics.length, 0, name + ': syntax diagnostics');
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'evaluate'
      ) {
        const callback = node.arguments[0];
        assert(
          ts.isPropertyAccessExpression(callback) &&
            ts.isIdentifier(callback.expression) &&
            ['callbacks', 'remoteCallbacks'].includes(callback.expression.text),
          name + ': remote callback must remain raw'
        );
      }
      ts.forEachChild(node, visit);
    }
    if (['desktop-worker.ts', 'inspector-probe.cjs'].includes(name)) visit(source);
  }
  assert(sources['../native-consent-proof.ts'].includes("import('./native/desktop-worker.js')"));
  assert(sources['../native-consent-proof.ts'].includes("import('./native/cli-worker.js')"));
  assert(sources['desktop-worker.ts'].includes('probe.probeInspector(application,'));
  assert(sources['desktop-worker.ts'].includes('scripts/local-browser/native/inspector-probe.cjs'));
  const callbacks = require('./remote-callbacks.cjs');
  const raw = fs.readFileSync(path.join(directory, 'remote-callbacks.cjs'), 'utf8');
  for (const callback of Object.values(callbacks)) {
    assert(raw.includes(callback.toString()));
    assert(!/\b__name\s*\(/.test(callback.toString()));
  }
  const guard = fs.readFileSync(path.join(directory, 'discovery-guard.cjs'), 'utf8');
  assert(guard.includes('function activate'));
  assert(!/\b__name\s*\(/.test(guard));
  return { maintainedCallsitesAudited: true, rawCallbacksVerbatim: true, executedNative: false };
};
