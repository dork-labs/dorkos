/**
 * Pins for the DOR-4943 waves of `check-vocab-gate.ts`: the app-copy voice
 * words (wave 9), the pronoun "I" (wave 10) and the five banned button labels
 * (wave 11).
 *
 * Each wave is read from the shipped `banned-terms.json`, so a test fails if
 * the data loses the field that scopes it (`roots`, `caseSensitive`,
 * `match`), not only if the matcher breaks. Every rule has a planted hit that
 * must fire and an allowed case that must stay silent. Also the connection
 * routes' API copy (DOR-2804, DOR-4978). A separate file from
 * `check-vocab-gate.test.ts` because that one is at its line ratchet.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBannedTerms, runVocabGate, scanSource, termsForPath } from '../check-vocab-gate.ts';

const CLIENT_FILE = 'apps/client/src/layers/features/foo/Panel.tsx';
const terms = loadBannedTerms();

/** Scan `jsx` as a client file against the shipped terms that apply there. */
function hits(jsx: string): string[] {
  return scanSource(CLIENT_FILE, jsx, termsForPath(CLIENT_FILE, terms))
    .filter((v) => ['wave-9', 'wave-10', 'wave-11'].includes(v.wave))
    .map((v) => v.term);
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Write `files` into a fresh temp repo and return its root. */
function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'vocab-gate-voice-'));
  tempDirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe('wave 9: "we", "please", "sorry", "oops" in client copy', () => {
  it('fires on each word in a copy position, contractions included', () => {
    expect(hits(`const A = () => <p>We sent a link.</p>;`)).toEqual(['we']);
    expect(hits(`const A = () => <p>In 72 hours, we’ll remove it.</p>;`)).toEqual(['we']);
    expect(hits(`toast.error('Please try again.');`)).toEqual(['please']);
    expect(hits(`const a = { message: 'Sorry, that did not work' };`)).toEqual(['sorry']);
    expect(hits(`const A = () => <p>Oops.</p>;`)).toEqual(['oops']);
  });

  it('is silent on the word inside another word, in code, and in comments', () => {
    expect(hits(`const A = () => <p>Weekly answers, sweet.</p>;`)).toEqual([]);
    // An identifier, an object key that is not copy, and a comment.
    expect(hits(`// we keep this\nconst we = { please: 1, kind: 'sorry' };`)).toEqual([]);
  });
});

describe('wave 10: the pronoun "I", matched case as written', () => {
  it('fires on a capital I in client copy', () => {
    expect(hits(`const A = () => <a>Where do I find this?</a>;`)).toEqual(['I']);
    expect(hits(`const A = () => <Button>I’ve finished</Button>;`)).toEqual(['I']);
  });

  it('is silent on a lowercase i and on I inside a word', () => {
    expect(hits(`const A = () => <p>Two files, i.e. both.</p>;`)).toEqual([]);
    expect(hits(`const A = () => <p>Install the iOS app. API keys stay here.</p>;`)).toEqual([]);
  });
});

describe('wave 11: OK, Yes, No, Submit, Confirm as a whole button label', () => {
  it('fires on a button whose whole label is banned', () => {
    expect(hits(`const A = () => <Button>OK</Button>;`)).toEqual(['OK']);
    expect(hits(`const A = () => <button type="submit">submit</button>;`)).toEqual(['Submit']);
    expect(hits(`const A = () => <AlertDialogAction>Yes</AlertDialogAction>;`)).toEqual(['Yes']);
    // An icon beside the text does not change the label.
    expect(hits(`const A = () => <Button><Check /> Confirm</Button>;`)).toEqual(['Confirm']);
    // A label chosen by a ternary is still the label.
    expect(hits(`const A = () => <Button>{busy ? 'Saving…' : 'No'}</Button>;`)).toEqual(['No']);
  });

  it('is silent when the word is part of a longer label or not on a button', () => {
    expect(hits(`const A = () => <p>No agents yet.</p>;`)).toEqual([]);
    expect(hits(`const A = () => <p>OK</p>;`)).toEqual([]);
    expect(hits(`const A = () => <Button>Confirm delete</Button>;`)).toEqual([]);
    expect(hits(`const A = () => <Button>No {name} account</Button>;`)).toEqual([]);
    expect(hits(`const a = { label: 'Yes' };`)).toEqual([]);
  });
});

describe('waves 9-11 apply to the client only', () => {
  it('fires in apps/client/src and stays silent in apps/site/src and apps/server/src', () => {
    const copy = `export const A = () => <Button>OK</Button>;\nexport const B = () => <p>We did it.</p>;\n`;
    const root = repoWith({
      'apps/client/src/layers/features/foo/A.tsx': copy,
      'apps/site/src/foo/A.tsx': copy,
      'apps/server/src/foo/A.tsx': copy,
    });
    const found = runVocabGate(root, ['apps/client/src', 'apps/site/src', 'apps/server/src'], []);
    expect(found.map((v) => [v.file, v.term])).toEqual([
      ['apps/client/src/layers/features/foo/A.tsx', 'OK'],
      ['apps/client/src/layers/features/foo/A.tsx', 'we'],
    ]);
  });
});

describe("the connection routes' API copy", () => {
  it('checks literal API errors and owner-refusal messages in connector management', () => {
    const repoRoot = join(import.meta.dirname, '../..');
    // The owner refusals live beside the management routes, in the boundary
    // every connector group shares (DOR-2804).
    const routePaths = [
      join(repoRoot, 'apps/server/src/routes/connector-management.ts'),
      join(repoRoot, 'apps/server/src/routes/connector-owner-boundary.ts'),
      // The fixed problem sentences for every connection refusal (DOR-4979).
      join(repoRoot, 'apps/server/src/routes/connector-problems.ts'),
      // The account-decision bar's sentences, shared by the hand routes and the
      // capability mount (DOR-4978): its own refusals, and each area's owner_only.
      join(repoRoot, 'apps/server/src/lib/http/account-decision-bar.ts'),
      join(repoRoot, 'packages/shared/src/capabilities.ts'),
    ];
    const apiCopy: string[] = [];

    function staticText(node: ts.Expression | undefined): string | undefined {
      if (node && ts.isStringLiteralLike(node)) return node.text;
      if (node && ts.isTemplateExpression(node)) {
        return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
      }
      return undefined;
    }

    for (const routePath of routePaths) {
      const sourceFile = ts.createSourceFile(
        routePath,
        readFileSync(routePath, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      const visit = (node: ts.Node): void => {
        // `detail` since the routes answer problem documents (DOR-4979).
        if (ts.isPropertyAssignment(node) && node.name.getText(sourceFile) === 'detail') {
          const text = staticText(node.initializer);
          if (text !== undefined) apiCopy.push(text);
        }
        // The account-decision bar's fixed sentence lists (ACCOUNT_DECISION_*).
        if (
          ts.isVariableDeclaration(node) &&
          node.name.getText(sourceFile).startsWith('ACCOUNT_DECISION_') &&
          node.initializer
        ) {
          const collect = (inner: ts.Node): void => {
            // Values only: an object's keys name the check, they are never sent.
            if (ts.isPropertyAssignment(inner)) collect(inner.initializer);
            else if (ts.isStringLiteralLike(inner)) apiCopy.push(inner.text);
            else ts.forEachChild(inner, collect);
          };
          collect(node.initializer);
        }
        if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === 'ownerRefusal') {
          const text = staticText(node.arguments[2]);
          if (text !== undefined) apiCopy.push(text);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    const copySource = apiCopy
      .map((text, index) => `const apiCopy${index} = { message: ${JSON.stringify(text)} };`)
      .join('\n');
    // Every refusal sentence the connection routes can send, found as `detail`
    // values and `ownerRefusal` sentences (DOR-4979 moved them from `error`).
    expect(apiCopy.length).toBeGreaterThan(40);
    expect(apiCopy).toContain(
      'Only the owner of this DorkOS can manage the connections on its DorkOS account.'
    );
    expect(scanSource(routePaths[0]!, copySource, loadBannedTerms())).toEqual([]);
  });
});
