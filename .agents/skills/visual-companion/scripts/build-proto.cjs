#!/usr/bin/env node
// Build a template prototype into one self-contained index.html, stamped with
// exact source locations for the review layer.
//
//   node build-proto.cjs <proto-dir> [--no-stamp] [--out index.html]
//
// <proto-dir>/src/head.html is the page. Its markers are replaced:
//   /*CSS*/       every file in build.json "css" (default: src/*.css, sorted)
//   /*JS*/        every file in build.json "js"  (default: src/*.js, sorted)
//   /*DIRECTOR*/  the director kit (scripts/director.js), so the page runs alone
// Every tag in head.html and in the JS templates gets data-src="src/<file>:<line>"
// (stamp-src.cjs), so a note says exactly where an element was written. The kit
// itself isn't stamped. Prints one JSON line: { ok, out, bytes, stamped }.
const fs = require('fs');
const path = require('path');
const { stampHtml, stampJs } = require('./stamp-src.cjs');

const argv = process.argv.slice(2);
const dir = path.resolve(argv.find((a) => !a.startsWith('--')) || '.');
const stamp = !argv.includes('--no-stamp');
const outName = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'index.html';
const src = path.join(dir, 'src');
const cfgFile = path.join(dir, 'build.json');
const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
const list = (ext) =>
  cfg[ext] ||
  fs
    .readdirSync(src)
    .filter((f) => f.endsWith('.' + ext))
    .sort();
const stats = { stamped: 0 };
const count = (before, after) =>
  (stats.stamped +=
    (after.match(/ data-src=/g) || []).length - (before.match(/ data-src=/g) || []).length);

function readStamped(file, fn) {
  const text = fs.readFileSync(path.join(src, file), 'utf8');
  if (!stamp || !fn) return text;
  const out = fn(text, 'src/' + file);
  count(text, out);
  return out;
}

let page = readStamped('head.html', stamp ? stampHtml : null);
const css = list('css')
  .map((f) => fs.readFileSync(path.join(src, f), 'utf8'))
  .join('\n');
const js = list('js')
  .map((f) => readStamped(f, stamp ? stampJs : null))
  .join('\n');
const kit = fs.readFileSync(path.join(__dirname, 'director.js'), 'utf8');
// Functions, so a `$&` in the sources stays as written.
page = page
  .replace('/*CSS*/', () => css)
  .replace('/*DIRECTOR*/', () => kit)
  .replace('/*JS*/', () => js);
const out = path.join(dir, outName);
fs.writeFileSync(out, page);
console.log(
  JSON.stringify({ ok: true, out, bytes: Buffer.byteLength(page), stamped: stats.stamped })
);
