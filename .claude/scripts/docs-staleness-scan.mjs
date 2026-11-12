#!/usr/bin/env node
/**
 * On-demand companion to check-dead-doc-paths.sh. Reports missing explicit
 * repo paths in docs/ and names of exports removed since a chosen revision.
 * This is a review worklist, not a CI gate or a semantic TypeScript checker.
 * Historical examples can use `doc-allow-stale: reason` on the same line.
 *
 * node .claude/scripts/docs-staleness-scan.mjs
 * node .claude/scripts/docs-staleness-scan.mjs --since=v0.115.0 --json
 *
 * Links and public assets are checked separately with lychee. This scan
 * includes code examples, where prose link checkers skip repo filenames.
 * Release notes preserve historical APIs; user-created *.local.json files
 * describe configuration, not tracked source. Neither is a stale-file signal.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const REPO_PATH =
  /^(?:apps|packages|scripts|contributing|decisions|specs|meta|research|plans|audits|\.claude|\.agents)\//;
const SAFE_FILE = /\.(?:[cm]?[jt]sx?|mdx?|json|ya?ml|sh|css|svg)$/;
const DECLARATION =
  /^-export\s+(?:(?:declare|default|abstract|async)\s+)*(?:class|function|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;
const CURRENT_DECLARATION =
  /^[\t ]*(?:export\s+)?(?:(?:declare|default|abstract|async)\s+)*(?:class|function|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
}

/** Resolve explicit filenames only; placeholders and directory sketches aren't files. */
export function missingPaths(text, root) {
  const findings = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.includes('doc-allow-stale:')) continue;
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const path = match[1].replace(/:\d+(?:-\d+)?$/, '');
      if (!REPO_PATH.test(path) || !SAFE_FILE.test(path)) continue;
      if (path.endsWith('.local.json')) continue;
      if (!/^[\w./-]+$/.test(path) || path.includes('..')) continue;
      if (!existsSync(join(root, path))) {
        findings.push({ line: index + 1, kind: 'missing-path', reference: path });
      }
    }
  }
  return findings;
}

/** Removed exports still declared elsewhere (including private code) aren't stale names. */
export function removedExports(diff, currentSources) {
  const removed = new Set([...diff.matchAll(DECLARATION)].map((match) => match[1]));
  for (const source of currentSources) {
    for (const declaration of source.matchAll(CURRENT_DECLARATION)) removed.delete(declaration[1]);
    if (removed.size === 0) break;
  }
  return removed;
}

export function staleSymbols(text, removed) {
  const findings = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.includes('doc-allow-stale:')) continue;
    const seen = new Set();
    // Inline names and identifiers in code examples both matter to a reader
    // copying a guide. Exact tokens avoid matching Foo inside FooBar.
    for (const token of line.matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (removed.has(token[0]) && !seen.has(token[0])) {
        seen.add(token[0]);
        findings.push({ line: index + 1, kind: 'removed-symbol', reference: token[0] });
      }
    }
  }
  return findings;
}

export function scan(root, { since } = {}) {
  const tracked = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  const documents = tracked.filter(
    (path) => /^docs\/.*\.mdx?$/.test(path) && !/^docs\/changelog(?:-archive)?\.mdx$/.test(path)
  );
  let removed = new Set();
  if (since) {
    if (since.startsWith('-')) throw new Error('The revision must not start with a dash');
    const revision = git(root, ['rev-parse', '--verify', `${since}^{commit}`]).trim();
    const code = tracked.filter(
      (path) =>
        /^(?:apps|packages)\//.test(path) &&
        CODE_EXT.test(path) &&
        !/(?:^|\/)(?:__tests__|__fixtures__|fixtures)\//.test(path) &&
        !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
    );
    // Pathspecs include deleted files too, and keep the argument list bounded
    // even in this repo's many-thousand-file source tree.
    const paths = ['apps', 'packages'].flatMap((dir) =>
      ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'].map(
        (extension) => `:(glob)${dir}/**/*.${extension}`
      )
    );
    const diff = git(root, ['diff', '--no-ext-diff', '--unified=0', revision, '--', ...paths]);
    function* sources() {
      for (const path of code) {
        if (existsSync(join(root, path))) yield readFileSync(join(root, path), 'utf8');
      }
    }
    removed = removedExports(diff, sources());
  }
  const findings = [];
  for (const file of documents) {
    if (!existsSync(join(root, file))) continue;
    const text = readFileSync(join(root, file), 'utf8');
    findings.push(
      ...[...missingPaths(text, root), ...staleSymbols(text, removed)].map((finding) => ({
        file,
        ...finding,
      }))
    );
  }
  return { documents: documents.length, since: since ?? null, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--json' && !/^--since=.+/.test(arg))) {
      throw new Error('Usage: docs-staleness-scan.mjs [--since=REVISION] [--json]');
    }
    const since = args.find((arg) => arg.startsWith('--since='))?.slice('--since='.length);
    const report = scan(root, { since });
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(
        `Docs staleness: ${report.findings.length} finding(s) in ${report.documents} docs`
      );
      if (!since) console.log('Symbol scan skipped; choose a revision with --since=REVISION.');
      for (const finding of report.findings) {
        console.log(`${finding.file}:${finding.line}: ${finding.kind}: ${finding.reference}`);
      }
    }
    process.exitCode = report.findings.length ? 1 : 0;
  } catch (error) {
    console.error(`Docs staleness scan failed: ${error.message}`);
    process.exitCode = 2;
  }
}
