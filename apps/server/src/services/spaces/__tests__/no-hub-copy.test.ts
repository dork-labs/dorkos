/**
 * No space page says "hub" (DOR-2957, specs/everything-is-a-space C8; meta/VOICE.md). "Hub" is an
 * internal word for a person's own DorkOS: the space page has no screen of one, and its copy says
 * Private or space instead. This reads every string and JSX text the server and the page carry,
 * never identifiers, comments or import paths, so the live-stream code may keep its own name.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { SPACE_SRC, SPACE_WEB_SRC } from './space-paths.js';

const WORD = /\bhubs?\b/iu;

/** Non-test source files of the server and of its page, each as a URL. */
function sources(): URL[] {
  const under = (root: URL) =>
    readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter(
        (name) =>
          /\.tsx?$/u.test(name) && !/(^|\/)__tests__\//u.test(name) && !/\.test\.tsx?$/u.test(name)
      )
      .map((name) => new URL(name, root));
  // The page's source sits inside the server's for now; each file is read once.
  const page = under(SPACE_WEB_SRC);
  const pageFiles = new Set(page.map(String));
  return [...under(SPACE_SRC).filter((url) => !pageFiles.has(String(url))), ...page];
}

/** Every copy position in one file's text that says "hub": strings, templates and JSX text. */
function hubCopy(fileName: string, text: string): string[] {
  // Every finding is a node whose raw text matches WORD, so a file whose raw text never does has
  // none: skip parsing it. Same result, and it keeps this scan off Vitest's 5s default on a loaded
  // shard (5.8s on 10-29, run 40974091418; ~1s idle, almost all of it parsing hub-free files).
  if (!WORD.test(text)) return [];
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const isModulePath =
      ts.isStringLiteral(node) &&
      (ts.isImportDeclaration(node.parent) ||
        ts.isExportDeclaration(node.parent) ||
        ts.isExternalModuleReference(node.parent) ||
        (ts.isCallExpression(node.parent) &&
          node.parent.expression.kind === ts.SyntaxKind.ImportKeyword));
    const copy =
      (ts.isStringLiteral(node) && !isModulePath) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node);
    if (copy && WORD.test(node.getText(file)))
      found.push(`${fileName}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('space page copy', () => {
  it('never says hub', () => {
    // Purpose: fails when any string or page text the space server or its page carries says
    // "hub" or "hubs", the internal word VOICE retires from copy.
    const files = sources();
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap((url) => hubCopy(fileURLToPath(url), readFileSync(url, 'utf8')));
    const page = readFileSync(new URL('index.html', SPACE_WEB_SRC), 'utf8');
    if (WORD.test(page)) found.push('index.html');
    expect(found).toEqual([]);
  });

  it('sees the word in copy and nowhere else', () => {
    // Purpose: fails if the scan misses copy (so the test above would pass whatever the page
    // says) or reads identifiers and import paths (so the live-stream code could not keep its name).
    const sample = [
      "import { LiveHub } from './live/hub.js';",
      "const hub: LiveHub = makeHub(); // the hub's streams",
      "const a = 'Open your hub';",
      'const b = `Your ${n} hubs`;',
      'const c = <p>Back to the Hub</p>;',
    ].join('\n');
    expect(hubCopy('sample.tsx', sample)).toEqual(['sample.tsx:3', 'sample.tsx:4', 'sample.tsx:5']);
  });
});
