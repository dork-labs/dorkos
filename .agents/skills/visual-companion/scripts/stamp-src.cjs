#!/usr/bin/env node
// Stamp every element a prototype renders with where it was written:
// data-src="file:line". The review layer reads el.closest('[data-src]'), so a
// pinned note tells the agent the exact line to edit. Exact source beats grep.
//
//   node stamp-src.cjs <file> [--root DIR] [--as LABEL]   stamped file to stdout
//   node stamp-src.cjs --dir SRC --out OUT [--root DIR]    stamp a tree into OUT
//                                                          (root defaults to SRC)
//
// .html: every start tag, plus inline <script>s (run through the JS pass).
// .js/.mjs/.cjs: tags inside string and template literals, the way template
// prototypes render (el.innerHTML = `<div>…</div>`). Code outside literals,
// comments and regexes is never touched. JSX is the Babel plugin's job
// (babel-plugin-data-src.cjs).
//
// Output is the input byte for byte plus the inserted attributes. Skipped:
// document chrome (html, head, meta, script, style…), anything inside an <svg>
// (the svg itself is stamped) or SVG-only by name, and tags that already
// carry data-src.
// Known limit: a string that is compared rather than rendered ('<b>' === x)
// gets stamped too.
const fs = require('fs');
const path = require('path');

const SKIP = new Set([
  'html',
  'head',
  'body',
  'meta',
  'link',
  'script',
  'style',
  'title',
  'base',
  'noscript',
  'template',
]);
// SVG-only names: icon tables keep <path>/<circle> fragments in their own
// strings, apart from any <svg>, and those are svg children all the same.
const SVG_ONLY = new Set(
  'path circle rect ellipse line polyline polygon g defs use symbol clippath mask lineargradient radialgradient stop pattern marker text tspan textpath image foreignobject desc metadata switch view animate animatemotion animatetransform set'.split(
    ' '
  )
);
const skip = (name) => SKIP.has(name) || SVG_ONLY.has(name) || name.startsWith('fe');
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const JS_TYPES = new Set([
  '',
  'text/javascript',
  'module',
  'application/javascript',
  'application/ecmascript',
  'text/ecmascript',
]);
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'yield',
  'await',
]);

// 1-based line of an offset, by binary search over newline positions.
function lines(text, offset) {
  const nl = [];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) nl.push(i);
  return (pos) => {
    let lo = 0;
    let hi = nl.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nl[mid] < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1 + offset;
  };
}

// Applies [pos, str] insertions to text, leaving every other byte alone.
function splice(text, ins) {
  if (!ins.length) return text;
  ins.sort((x, y) => x[0] - y[0]);
  let out = '';
  let last = 0;
  for (const [pos, str] of ins) {
    out += text.slice(last, pos) + str;
    last = pos;
  }
  return out + text.slice(last);
}

function count(opts, n) {
  if (opts.stats) opts.stats.count = (opts.stats.count || 0) + n;
}

const isLetter = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isNameChar = (c) => isLetter(c) || (c >= '0' && c <= '9') || c === '-';
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

// ---------- HTML ----------

// Reads a start tag's attributes from i (just after the name). Returns the
// index of its closing '>' (or text.length), the attribute names and the
// attribute map, quote-aware so a '<' or '>' in a value isn't a tag.
function readAttrs(text, i) {
  const attrs = {};
  let selfClose = false;
  while (i < text.length) {
    const c = text[i];
    if (isSpace(c)) {
      i++;
    } else if (c === '>') {
      return { end: i, attrs, selfClose };
    } else if (c === '/') {
      selfClose = text[i + 1] === '>';
      i++;
    } else {
      let j = i;
      while (
        j < text.length &&
        !isSpace(text[j]) &&
        text[j] !== '=' &&
        text[j] !== '>' &&
        !(text[j] === '/' && text[j + 1] === '>')
      )
        j++;
      const name = text.slice(i, j).toLowerCase();
      let k = j;
      while (isSpace(text[k])) k++;
      let value = '';
      if (text[k] === '=') {
        k++;
        while (isSpace(text[k])) k++;
        if (text[k] === '"' || text[k] === "'") {
          const close = text.indexOf(text[k], k + 1);
          const stop = close === -1 ? text.length : close;
          value = text.slice(k + 1, stop);
          k = stop + 1;
        } else {
          const s = k;
          while (k < text.length && !isSpace(text[k]) && text[k] !== '>') k++;
          value = text.slice(s, k);
        }
        j = k;
      }
      attrs[name] = value;
      selfClose = false;
      i = Math.max(j, i + 1);
    }
  }
  return { end: text.length, attrs, selfClose };
}

function stampHtml(text, file, opts = {}) {
  const lineOf = lines(text, opts.lineOffset || 0);
  const lower = text.toLowerCase();
  const ins = [];
  let svg = 0;
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      i = e === -1 ? text.length : e + 3;
      continue;
    }
    if (text[lt + 1] === '!' || text[lt + 1] === '?') {
      const e = text.indexOf('>', lt);
      i = e === -1 ? text.length : e + 1;
      continue;
    }
    if (text[lt + 1] === '/') {
      let j = lt + 2;
      while (isNameChar(text[j] || '')) j++;
      if (svg && text.slice(lt + 2, j).toLowerCase() === 'svg') svg--;
      const e = text.indexOf('>', j);
      i = e === -1 ? text.length : e + 1;
      continue;
    }
    if (!isLetter(text[lt + 1] || '')) {
      i = lt + 1;
      continue;
    }
    let j = lt + 2;
    while (isNameChar(text[j] || '')) j++;
    const name = text.slice(lt + 1, j).toLowerCase();
    const tag = readAttrs(text, j);
    if (!svg && !skip(name) && !('data-src' in tag.attrs))
      ins.push([j, ` data-src="${file}:${lineOf(lt)}"`]);
    if (name === 'svg' && !tag.selfClose) svg++;
    i = tag.end + 1;
    if (RAW.has(name) && !tag.selfClose) {
      // Raw text runs to its closing tag; only an inline JS script is looked inside.
      const close = lower.indexOf('</' + name, i);
      const end = close === -1 ? text.length : close;
      const type = (tag.attrs.type || '').trim().toLowerCase();
      if (name === 'script' && JS_TYPES.has(type) && end > i) {
        for (const [p, s] of scanJs(text.slice(i, end), file, lineOf(i) - 1)) ins.push([i + p, s]);
      }
      i = end;
    }
  }
  count(opts, ins.length);
  return splice(text, ins);
}

// ---------- JS ----------

// Stamps tags in one chunk of literal text [s, e). ctx carries the svg depth;
// q is the quote to use so the attribute can't end the JS string.
function stampChunk(text, s, e, ctx, q, file, lineOf, ins) {
  for (let lt = text.indexOf('<', s); lt !== -1 && lt < e; lt = text.indexOf('<', lt + 1)) {
    const closing = text[lt + 1] === '/';
    const n0 = lt + (closing ? 2 : 1);
    if (!isLetter(text[n0] || '')) continue;
    let j = n0 + 1;
    while (j < e && isNameChar(text[j])) j++;
    if (j < e && !isSpace(text[j]) && text[j] !== '>' && text[j] !== '/') continue;
    const name = text.slice(n0, j).toLowerCase();
    if (closing) {
      if (name === 'svg' && ctx.svg) ctx.svg--;
      continue;
    }
    const gt = text.indexOf('>', j);
    const rest = text.slice(j, gt === -1 || gt > e ? e : gt);
    const selfClose = gt !== -1 && gt <= e && text[gt - 1] === '/';
    if (!ctx.svg && !skip(name) && !/(^|\s)data-src\s*=/.test(rest))
      ins.push([j, ` data-src=${q}${file}:${lineOf(lt)}${q}`]);
    if (name === 'svg' && !selfClose) ctx.svg++;
  }
}

// Finds the insertions for a JS source: a small scanner that knows comments,
// strings, templates (with nested ${ }) and regexes, and only looks for tags
// inside literal text.
function scanJs(text, file, lineOffset) {
  const lineOf = lines(text, lineOffset);
  const ins = [];
  const n = text.length;
  const stack = []; // one entry per open ${ … }: { braces, tpl }
  let braces = 0;
  let prev = 'punct'; // what came before: 'punct' (a regex may follow) or 'value'
  let i = 0;
  if (text.startsWith('#!')) i = text.indexOf('\n') === -1 ? n : text.indexOf('\n');

  // Scans template text from i up to its closing ` (or the next ${), stamping as it goes.
  const template = (tpl) => {
    const s = i;
    while (i < n) {
      const c = text[i];
      if (c === '\\') i += 2;
      else if (c === '`') {
        stampChunk(text, s, i, tpl, '"', file, lineOf, ins);
        i++;
        prev = 'value';
        return;
      } else if (c === '$' && text[i + 1] === '{') {
        stampChunk(text, s, i, tpl, '"', file, lineOf, ins);
        i += 2;
        stack.push({ braces, tpl });
        braces = 0;
        prev = 'punct';
        return;
      } else i++;
    }
    stampChunk(text, s, n, tpl, '"', file, lineOf, ins);
  };
  // Literals inside ${ } start inside whatever svg their template is in.
  const depth = () => (stack.length ? stack[stack.length - 1].tpl.svg : 0);

  while (i < n) {
    const c = text[i];
    if (isSpace(c)) {
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      const e = text.indexOf('\n', i);
      i = e === -1 ? n : e;
    } else if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e === -1 ? n : e + 2;
    } else if (c === '"' || c === "'") {
      const s = ++i;
      while (i < n && text[i] !== c && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
      stampChunk(
        text,
        s,
        Math.min(i, n),
        { svg: depth() },
        c === '"' ? "'" : '"',
        file,
        lineOf,
        ins
      );
      i++;
      prev = 'value';
    } else if (c === '`') {
      i++;
      template({ svg: depth() });
    } else if (c === '/') {
      if (prev === 'punct') {
        // A regex literal: skip it whole, classes included, so /"<a/ is inert.
        i++;
        let cls = false;
        while (i < n && text[i] !== '\n') {
          const r = text[i];
          if (r === '\\') i++;
          else if (r === '[') cls = true;
          else if (r === ']') cls = false;
          else if (r === '/' && !cls) break;
          i++;
        }
        i++;
        while (i < n && /[a-z]/i.test(text[i])) i++;
        prev = 'value';
      } else {
        i++;
        prev = 'punct';
      }
    } else if (c === '{') {
      braces++;
      i++;
      prev = 'punct';
    } else if (c === '}') {
      i++;
      if (braces === 0 && stack.length) {
        const top = stack.pop();
        braces = top.braces;
        template(top.tpl);
      } else {
        braces = Math.max(0, braces - 1);
        prev = 'punct';
      }
    } else if (/[A-Za-z0-9_$#\u0080-\uffff]/.test(c)) {
      const s = i;
      while (i < n && /[A-Za-z0-9_$#.\u0080-\uffff]/.test(text[i])) i++;
      prev = REGEX_AFTER_WORD.has(text.slice(s, i)) ? 'punct' : 'value';
    } else {
      i++;
      // After ) or ] a slash divides; after any other punctuator it starts a regex.
      prev = c === ')' || c === ']' ? 'value' : 'punct';
    }
  }
  return ins;
}

function stampJs(text, file, opts = {}) {
  const ins = scanJs(text, file, opts.lineOffset || 0);
  count(opts, ins.length);
  return splice(text, ins);
}

// ---------- files ----------

const slash = (p) => p.split(path.sep).join('/');

function stampFile(file, opts = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const label = opts.as || slash(opts.root ? path.relative(opts.root, file) : file);
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html' || ext === '.htm') return stampHtml(text, label, opts);
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return stampJs(text, label, opts);
  return text;
}

function stampDir(src, out, root = src) {
  const stats = { count: 0 };
  let files = 0;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, ent.name);
      if (
        path.resolve(from) === path.resolve(out) ||
        ent.name === 'node_modules' ||
        ent.name === '.git'
      )
        continue;
      const to = path.join(out, path.relative(src, from));
      if (ent.isDirectory()) {
        walk(from);
      } else if (ent.isFile()) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        if (/\.(html?|[cm]?js)$/i.test(ent.name)) {
          fs.writeFileSync(to, stampFile(from, { root, stats }));
          files++;
        } else fs.copyFileSync(from, to);
      }
    }
  };
  walk(src);
  return { ok: true, files, stamped: stats.count };
}

function main(argv) {
  const flag = (k) => {
    const at = argv.indexOf(k);
    return at === -1 ? undefined : argv[at + 1];
  };
  const root = flag('--root');
  if (argv.includes('--dir')) {
    const src = flag('--dir');
    const out = flag('--out');
    if (!src || !out) throw new Error('--dir needs --out');
    process.stdout.write(JSON.stringify(stampDir(src, out, root || src)) + '\n');
    return;
  }
  const file = argv.find(
    (a, k) => !a.startsWith('--') && !['--root', '--as'].includes(argv[k - 1])
  );
  if (!file)
    throw new Error(
      'usage: stamp-src.cjs <file> [--root DIR] [--as LABEL] | --dir SRC --out OUT [--root DIR]'
    );
  process.stdout.write(stampFile(file, { root, as: flag('--as') }));
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(e.message + '\n');
    process.exit(1);
  }
}

module.exports = { stampHtml, stampJs, stampFile, stampDir };
