/**
 * No space page says "hub" (DOR-2957, specs/everything-is-a-space C8; meta/VOICE.md). "Hub" is an
 * internal word for a person's own DorkOS: the space page has no screen of one, and its copy says
 * Private or space instead. This reads every string and JSX text the server and the page carry,
 * never identifiers, comments or import paths, so the live-stream code may keep its own name.
 */
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../', import.meta.url);
const WORD = /\bhubs?\b/iu;

/** Non-test source files under `src/`, relative to it. */
function sources(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter(
    (name) =>
      /\.tsx?$/u.test(name) && !/(^|\/)__tests__\//u.test(name) && !/\.test\.tsx?$/u.test(name)
  );
}

/** Every copy position in one file's text that says "hub": strings, templates and JSX text. */
function hubCopy(fileName: string, text: string): string[] {
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
    const found = files.flatMap((name) => hubCopy(name, readFileSync(new URL(name, SRC), 'utf8')));
    const page = readFileSync(new URL('browser/index.html', SRC), 'utf8');
    if (WORD.test(page)) found.push('browser/index.html');
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
