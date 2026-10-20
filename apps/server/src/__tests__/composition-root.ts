/**
 * The server's composition root as one text, for the source guards that pin
 * its wiring and its boot order.
 *
 * `start()` in `index.ts` runs startup as a sequence of steps in `startup/steps/`
 * (`claimDataDirectory`, `wireRooms`, …), each called as `step(refs, …)`. A
 * guard that asks "is X wired before Y" cares about the order the code runs
 * in, not which file holds it, so this returns `index.ts` with every step call
 * replaced by that step's own body, in the order `start()` calls them. The
 * steps' imports are added after `index.ts`'s own, written relative to
 * `apps/server/src` as `index.ts` would write them. The result parses as
 * TypeScript; it is a text to search, never a module to run.
 *
 * What it does not do: undo `refs.`. The steps reach the server's live
 * references (`startup/server-refs.ts`) through `refs`, and a guard that names
 * one of them names it the way the code now reads.
 *
 * @module __tests__/composition-root
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** `apps/server/src`. */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The composition root's own path, for messages and parsers that want one. */
export const COMPOSITION_ROOT_PATH = path.join(SRC, 'index.ts');

/** A parsed file under `apps/server/src`. */
function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

/**
 * A relative import in a step, written relative to `apps/server/src` as
 * `index.ts` would write it. A package import is returned as it is.
 *
 * @param specifier - The specifier as the step wrote it.
 * @param file - The step's own path.
 */
function fromSrc(specifier: string, file: string): string {
  if (!specifier.startsWith('.')) return specifier;
  return `./${path
    .relative(SRC, path.resolve(path.dirname(file), specifier))
    .split(path.sep)
    .join('/')}`;
}

/**
 * `index.ts` with each `startup/steps/` step it calls from `start()` replaced by the
 * step's body, in boot order. Read fresh on every call.
 *
 * @returns The composed source text.
 */
export function compositionRootSource(): string {
  const index = parse(COMPOSITION_ROOT_PATH);
  const text = index.getFullText();

  // Which imported names are steps, and the file each lives in. Every value
  // `index.ts` imports from `startup/steps/` is a step.
  const stepFiles = new Map<string, string>();
  for (const statement of index.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (!specifier.startsWith('./startup/steps/') || clause?.isTypeOnly) continue;
    if (!bindings || !ts.isNamedImports(bindings) || clause?.name)
      throw new Error(`index.ts imports ${specifier} in a shape this reader does not inline`);
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      stepFiles.set(element.name.text, path.join(SRC, specifier.replace(/\.js$/, '.ts')));
    }
  }

  const start = index.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'start'
  );
  if (!start?.body) throw new Error('index.ts has no start() to read');

  const edits: { from: number; to: number; text: string }[] = [];
  const stepImports: string[] = [];
  const inlined = new Map<string, number>();
  for (const statement of start.body.statements) {
    const step = calledStep(statement, stepFiles);
    if (!step) continue;
    inlined.set(step, (inlined.get(step) ?? 0) + 1);
    const file = parse(stepFiles.get(step)!);
    const declaration = file.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === step
    );
    if (!declaration?.body) throw new Error(`startup step ${step} has no body to read`);
    const body = file
      .getFullText()
      .slice(declaration.body.getStart() + 1, declaration.body.end - 1);
    edits.push({ from: statement.getStart(), to: statement.getEnd(), text: body });
    for (const node of file.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      const imported = node.getText(file);
      const specifier = node.moduleSpecifier.text;
      stepImports.push(
        imported.replace(`'${specifier}'`, `'${fromSrc(specifier, file.fileName)}'`)
      );
    }
  }

  // A step called any other way (not as a statement of `start()`, not with
  // `refs` first, or twice) would drop out of the composed text, or appear in
  // it twice, and every guard reading it would quietly read the wrong boot.
  for (const step of stepFiles.keys()) {
    const count = inlined.get(step) ?? 0;
    if (count !== 1)
      throw new Error(
        `startup step ${step} is inlined ${count} times; start() must call it once, as step(refs, …)`
      );
  }

  let composed = text;
  for (const edit of edits.sort((a, b) => b.from - a.from)) {
    composed = composed.slice(0, edit.from) + edit.text + composed.slice(edit.to);
  }
  const lastImport = [...index.statements].filter(ts.isImportDeclaration).at(-1);
  const at = lastImport ? lastImport.getEnd() : 0;
  return `${composed.slice(0, at)}\n${stepImports.join('\n')}${composed.slice(at)}`;
}

/**
 * The step a `start()` statement calls as `step(refs, …)`, if it calls one.
 *
 * @param statement - A statement directly in `start()`'s body.
 * @param stepFiles - The imported step names.
 */
function calledStep(statement: ts.Statement, stepFiles: Map<string, string>): string | undefined {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      stepFiles.has(node.expression.text) &&
      node.arguments[0] !== undefined &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === 'refs'
    ) {
      found.push(node.expression.text);
    }
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  };
  visit(statement);
  if (found.length > 1)
    throw new Error(
      `one start() statement calls ${found.length} startup steps: ${found.join(', ')}`
    );
  return found[0];
}
