// stamp-src: every rendered element carries data-src="file:line" so the review
// layer can name the exact source line. No server; the example-prototype check uses a browser.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { SKILL } = require('./lib.cjs');

const STAMP = path.join(SKILL, 'scripts/stamp-src.cjs');
const { stampHtml, stampJs, stampFile } = require(STAMP);
// Removes only what the stamper added (for that label), so pre-existing data-src stays.
const strip = (s, file = '[^"\':]+') =>
  s.replace(new RegExp(` data-src=(["'])${file}:\\d+\\1`, 'g'), '');
const srcs = (s) =>
  [...s.matchAll(/<([a-zA-Z][\w-]*) data-src=(["'])([^"']*)\2/g)].map((m) => m[1] + '@' + m[3]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vc-stamp-'));

test('html: start tags get file:line, document chrome does not', () => {
  const html = [
    '<!doctype html>', // 1
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>T <b>x</b></title>',
    '<style>.a<b{color:red}</style>',
    '<link rel="stylesheet" href="x.css"></head>', // 5
    '<body>',
    '<!-- <div class="nope"> -->',
    '<main class="m">',
    '  <button title="a <b> c" data-x=\'<i>\'>Go</button>',
    '  <svg viewBox="0 0 2 2"><path d="M0 0"/><g><circle r="1"/></g></svg>', // 10
    '  <p data-src="kept.html:1">kept</p>',
    '  <textarea><div>raw</div></textarea>',
    '  <template><li class="t">x</li></template>',
    '  <section',
    '    class="multi">', // 15
    '</main></body></html>',
  ].join('\n');
  const out = stampHtml(html, 'page.html');
  assert.deepEqual(srcs(out), [
    'main@page.html:8',
    'button@page.html:9',
    'svg@page.html:10',
    'p@kept.html:1',
    'textarea@page.html:12',
    'li@page.html:13',
    'section@page.html:14',
  ]);
  assert.ok(out.includes('<p data-src="kept.html:1">'), 'existing data-src kept, not doubled');
  assert.ok(out.includes('<!-- <div class="nope"> -->'), 'comment untouched');
  assert.ok(
    out.includes('<textarea data-src="page.html:12"><div>raw</div></textarea>'),
    'textarea contents raw'
  );
  assert.equal(strip(out, 'page\\.html'), html, 'byte-identical apart from the attributes');
  assert.equal(
    stampHtml(html, 'page.html', { lineOffset: 100 }).includes('page.html:108'),
    true,
    'lineOffset adds'
  );
});

test('html: inline scripts are stamped through the JS pass, JSON scripts are not', () => {
  const html = [
    '<div id="root"></div>', // 1
    '<script>',
    '  const n = 2; if (n < 3) {',
    '    root.innerHTML = `<ul class="l">',
    '      ${[1, 2].map((i) => `<li>${i}</li>`).join("")}', // 5
    '    </ul>`;',
    '  }',
    '</script>',
    '<script type="application/json">{"html": "<div>no</div>"}</script>',
    '<script type="module">document.body.insertAdjacentHTML("beforeend", "<aside class=\'a\'>x</aside>")</script>', // 10
  ].join('\n');
  const out = stampHtml(html, 'p.html');
  assert.deepEqual(srcs(out), ['div@p.html:1', 'ul@p.html:4', 'li@p.html:5', 'aside@p.html:10']);
  assert.ok(
    out.includes("<aside data-src='p.html:10' class='a'>"),
    'double-quoted JS string gets single quotes'
  );
  assert.ok(out.includes('{"html": "<div>no</div>"}'), 'JSON untouched');
  assert.ok(out.includes('if (n < 3)'), 'code untouched');
  assert.equal(strip(out), html);
});

test('js: templates, nested ${}, both quote styles', () => {
  const js = [
    'const a = `<div class="card">', // 1
    "  ${ok ? `<b>x</b>` : ''}",
    "  ${list.map((x) => `<span>${x}</span>`).join('')}",
    '</div>`;',
    'const b = \'<em class="e">\' + "<strong class=\'s\'>";', // 5
    'const c = "<a href=\'#\'>";',
  ].join('\n');
  const out = stampJs(js, 'ui.js');
  assert.deepEqual(srcs(out), [
    'div@ui.js:1',
    'b@ui.js:2',
    'span@ui.js:3',
    'em@ui.js:5',
    'strong@ui.js:5',
    'a@ui.js:6',
  ]);
  assert.ok(
    out.includes('<em data-src="ui.js:5" class="e">'),
    'single-quoted string gets double quotes'
  );
  assert.ok(
    out.includes("<strong data-src='ui.js:5' class='s'>"),
    'double-quoted string gets single quotes'
  );
  assert.ok(out.includes('`<b data-src="ui.js:2">x</b>`'), 'templates get double quotes');
  assert.equal(strip(out), js);
  new Function(out); // still parses
});

test('js: regexes, comparisons and comments are left alone', () => {
  const js = [
    'const re = /<a "/g, re2 = /[/<div]/;', // 1
    "if (a < b && i<n) x = s.replace(/\"<b /, '') + `<i>${a / 2}</i>`;",
    '// <div class="c">',
    '/* <section> */',
    "function f() { return /<p'/.test(q) ? \"<p class='y'>\" : `<p>${1}</p>` }", // 5
    'const svg = `<svg viewBox="0 0 1 1">${`<path d="M0"/>`}<g></g></svg><hr/>`;',
    'const icon = \'<path d="M1"/>\';',
    'const done = `<p data-src="x.js:9">`; const w = n<b && m>a; const z = "<br>";',
  ].join('\n');
  const out = stampJs(js, 'f.js');
  assert.deepEqual(srcs(out), [
    'i@f.js:2',
    'p@f.js:5',
    'p@f.js:5',
    'svg@f.js:6',
    'hr@f.js:6',
    'p@x.js:9',
    'br@f.js:8',
  ]);
  assert.equal(strip(out, 'f\\.js'), js);
  assert.ok(
    out.includes('/<a "/g') && out.includes('/[/<div]/') && out.includes("/<p'/"),
    'regexes untouched'
  );
  assert.ok(out.includes('a < b && i<n'), 'comparisons untouched');
  assert.ok(
    out.includes('// <div class="c">') && out.includes('/* <section> */'),
    'comments untouched'
  );
  new Function(out);
});

test('stampFile picks by extension and records paths relative to root', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'src/sub'), { recursive: true });
  fs.writeFileSync(path.join(d, 'src/sub/v.js'), 'x.innerHTML = `\n<nav></nav>`;');
  fs.writeFileSync(path.join(d, 'src/a.css'), '.a<b{}');
  assert.ok(
    stampFile(path.join(d, 'src/sub/v.js'), { root: path.join(d, 'src') }).includes(
      '<nav data-src="sub/v.js:2">'
    )
  );
  assert.equal(stampFile(path.join(d, 'src/a.css'), {}), '.a<b{}');
  const cli = execFileSync(
    process.execPath,
    [STAMP, path.join(d, 'src/sub/v.js'), '--as', 'views.js'],
    { encoding: 'utf8' }
  );
  assert.ok(cli.includes('<nav data-src="views.js:2">'));
});

test('--dir stamps a tree into --out and copies the rest', () => {
  const d = tmp();
  const src = path.join(d, 'src');
  fs.mkdirSync(path.join(src, 'js'), { recursive: true });
  fs.writeFileSync(
    path.join(src, 'index.html'),
    '<main>\n<p>a</p></main>\n<script src="js/app.js"></script>'
  );
  fs.writeFileSync(
    path.join(src, 'js/app.js'),
    "document.querySelector('main').innerHTML += '<b>1</b>' + `\n<i>2</i>`;"
  );
  fs.writeFileSync(path.join(src, 'style.css'), 'main{}');
  const r = JSON.parse(
    execFileSync(process.execPath, [STAMP, '--dir', src, '--out', path.join(d, 'out')], {
      encoding: 'utf8',
    }).trim()
  );
  assert.deepEqual(r, { ok: true, files: 2, stamped: 4 });
  assert.equal(fs.readFileSync(path.join(d, 'out/style.css'), 'utf8'), 'main{}');
  assert.ok(
    fs.readFileSync(path.join(d, 'out/index.html'), 'utf8').includes('<p data-src="index.html:2">')
  );
  assert.ok(
    fs.readFileSync(path.join(d, 'out/js/app.js'), 'utf8').includes('<i data-src="js/app.js:2">')
  );
});

// Babel is never a dependency of the skill: borrow @babel/core read-only from the
// DorkOS repo's pnpm store when it's there, and skip when it isn't.
function findBabel() {
  let base;
  try {
    base = path.join(require('../scripts/locate.cjs').findDorkosRepo(), 'node_modules/.pnpm');
  } catch {
    return null;
  }
  const d = fs.existsSync(base) && fs.readdirSync(base).find((x) => x.startsWith('@babel+core@'));
  if (!d) return null;
  try {
    return require(path.join(base, d, 'node_modules/@babel/core'));
  } catch {
    return null;
  }
}

test('babel plugin stamps host JSX elements with file:line:col', (t) => {
  const babel = findBabel();
  if (!babel) return t.skip('@babel/core not found in the DorkOS repo install (VC_DORKOS_REPO)');
  const root = tmp();
  const code = [
    'export function App({ items }) {', // 1
    '  return (',
    '    <main className="app">',
    '      <Card title="x"><span>in card</span></Card>',
    '      <motion.div animate={{ opacity: 1 }} />', // 5
    '      <button data-src="keep.jsx:1" {...rest}>Go</button>',
    '      {items.map((i) => <li key={i}>{i}</li>)}',
    '    </main>',
    '  );',
    '}',
  ].join('\n');
  const opts = (extra) => ({
    filename: path.join(root, 'src/App.jsx'),
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ['jsx'] },
    plugins: [[path.join(SKILL, 'scripts/babel-plugin-data-src.cjs'), { root, ...extra }]],
  });
  const out = babel.transformSync(code, opts()).code;
  assert.ok(out.includes('<main data-src="src/App.jsx:3:5" className="app">'), out);
  assert.ok(out.includes('<span data-src="src/App.jsx:4:23">'), out);
  assert.ok(out.includes('<li data-src="src/App.jsx:7:25" key={i}>'), out);
  assert.ok(out.includes('<Card title="x">'), 'components are not stamped');
  assert.ok(!/motion\.div data-src/.test(out), 'member expressions are not stamped');
  assert.equal((out.match(/data-src=/g) || []).length, 4, 'existing data-src kept, not doubled');
  assert.ok(
    !babel.transformSync(code, opts({ include: /\.tsx$/ })).code.includes('data-src="src/'),
    'include filters files'
  );
  const nm = babel.transformSync(code, {
    ...opts(),
    filename: path.join(root, 'node_modules/x/App.jsx'),
  }).code;
  assert.ok(!nm.includes('data-src="node_modules'), 'node_modules skipped');
});

// Real code: the example prototype, stamped as a tree (the CLI's --dir mode) and
// built the way build-proto.cjs does, must run and point back at its sources.
const PROTO_SRC = path.join(SKILL, 'examples/prototype/src');
test('the example prototype survives stamping and points at its sources', async () => {
  const d = tmp();
  fs.cpSync(PROTO_SRC, path.join(d, 'src'), { recursive: true });
  const out = path.join(d, 'stamped');
  const r = JSON.parse(
    execFileSync(process.execPath, [STAMP, '--dir', path.join(d, 'src'), '--out', out], {
      encoding: 'utf8',
    }).trim()
  );
  assert.ok(r.stamped > 20, 'stamped ' + r.stamped);
  for (const f of fs.readdirSync(out)) {
    const raw = fs.readFileSync(path.join(d, 'src', f), 'utf8');
    const got = fs.readFileSync(path.join(out, f), 'utf8');
    assert.equal(
      strip(got, f.replace('.', '\\.')),
      raw,
      f + ' is byte-identical apart from the attributes'
    );
    if (f.endsWith('.js')) execFileSync(process.execPath, ['--check', path.join(out, f)]);
  }
  // Same order and placeholders as build-proto.cjs, from the stamped copies.
  const s = (f) => fs.readFileSync(path.join(out, f), 'utf8');
  const index = path.join(d, 'index.html');
  fs.writeFileSync(
    index,
    s('head.html')
      .replace('/*CSS*/', () => s('style.css'))
      .replace('/*DIRECTOR*/', () =>
        fs.readFileSync(path.join(SKILL, 'scripts/director.js'), 'utf8')
      )
      .replace('/*JS*/', () => s('data.js') + '\n' + s('app.js'))
  );
  const line = (f, needle) =>
    f +
    ':' +
    (fs
      .readFileSync(path.join(PROTO_SRC, f), 'utf8')
      .split('\n')
      .findIndex((l) => l.includes(needle)) +
      1);

  const { browser, watchErrors } = require('./lib.cjs');
  const b = await browser();
  try {
    const page = await b.newPage();
    const errors = watchErrors(page);
    await page.goto('file://' + index);
    await page.waitForSelector('#list [data-src*=".js:"]');
    const got = await page.evaluate(() => ({
      button: document.querySelector('#newBtn').closest('[data-src]').dataset.src,
      row: document.querySelector('#list .row').dataset.src,
      inSvg: document.querySelectorAll('svg [data-src]').length,
    }));
    assert.deepEqual(errors, []);
    assert.equal(got.button, line('head.html', 'id="newBtn"'));
    assert.equal(got.row, line('app.js', 'class="row"'));
    assert.equal(got.inSvg, 0, 'no svg children stamped');
  } finally {
    await b.close();
  }
});
