// @vitest-environment node
/**
 * **One failed mutation, one toast** (DOR-1378, research §2.4 item 1).
 *
 * `query-client.ts`'s global `MutationCache.onError` toasts every failed
 * mutation already — it is the ONE handler TanStack guarantees still runs
 * when a component has unmounted or a second `mutate()` superseded the
 * first. A hook that ALSO toasts from its own `useMutation({ onError })`
 * stacks a second, uncoordinated report on top of it: the operator saw the
 * same failure twice, in two different voices, ~10 verified times over.
 *
 * The fix is `meta.errorLabel` (compose with the shared toast) or
 * `meta.suppressErrorToast` (opt out because the surface reports it richer,
 * or handles it as something other than a toast). Either is fine; declaring
 * neither while a `useMutation` handler still calls `toast(...)` is the
 * defect this file watches for.
 *
 * **Checked against the source, not a rendered tree** — the shape here is a
 * hook nobody thought to mount inside a toast-asserting test, the same
 * reason `one-create-surface.test.ts` scans source. Two claims, each written
 * so it can fail:
 *
 * 1. **The scan itself is not vacuous.** {@link findViolations} is unit-tested
 *    directly against synthetic snippets first — a seeded violation (a plain
 *    onError toast, no meta) must be caught, and each legitimate shape
 *    (`errorLabel`, `suppressErrorToast`, a named constant carrying either,
 *    an implicit-return arrow, nested brackets in the handler body) must NOT
 *    be. Only once the detector is proven does the real tree get to lean on it.
 * 2. **The real tree has none.** Every `.ts`/`.tsx` file under `apps/client/src`
 *    (tests excluded) is scanned, and the violation list must be empty.
 *
 * **Known blind spot, by design, not oversight**: this only sees a toast
 * called from INSIDE a `useMutation({ onError: ... })` handler — the shape
 * `meta` actually governs. A `mutate(vars, { onError })` call-time callback
 * (`ChannelCreateDialog.tsx`'s old pattern, `NewMenu.tsx`'s today) is a
 * different mechanism the shared cache handler still runs ahead of — DOR-1378
 * swept those by hand because there is no `meta` slot on a call-time option to
 * check. A source scan can only hold the shape it can name.
 *
 * @module __tests__/one-error-one-toast
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC_DIR = join(__dirname, '..');

/**
 * The text between `start` and the delimiter that closes it — a `,` at
 * bracket-depth zero, or the bracket that opened the ENCLOSING container.
 *
 * Generic on purpose: called once to pull a whole `useMutation(...)` call's
 * argument out from after its `(`, and again to pull one property's value out
 * from after its `:` — an object literal, an arrow function with a block
 * body, or an implicit-return expression all end the same way syntactically
 * (the next top-level comma or the container's own close), so one balancer
 * serves both. Strings are tracked so a brace or comma quoted inside one
 * (`"Couldn't create that channel — {slug}"`) is never mistaken for structure.
 *
 * @param text - The source text to scan.
 * @param start - Index to start scanning from (leading whitespace is skipped).
 */
function extractBalancedValue(text: string, start: number): string {
  let i = start;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  const valueStart = i;
  let depth = 0;
  let inString: string | null = null;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') {
      depth++;
      continue;
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      if (depth === 0) return text.slice(valueStart, i);
      depth--;
      continue;
    }
    if (depth === 0 && ch === ',') return text.slice(valueStart, i);
  }
  return text.slice(valueStart, i);
}

/** A `toast(...)` or `toast.<method>(...)` call. */
const TOAST_CALL = /\btoast(\.\w+)?\s*\(/;

/** Either escape hatch `query-client.ts`'s `MutationCache.onError` honors. */
const META_ESCAPE_HATCH = /\berrorLabel\b|\bsuppressErrorToast\b/;

/**
 * Does `meta`'s captured value carry an escape hatch, resolving one level of
 * indirection when the value is a bare identifier?
 *
 * `entities/relay/model/use-adapter-catalog.ts` declares `meta: OWN_ERROR_TOAST`
 * three times, pointing at one documented `const OWN_ERROR_TOAST = {
 * suppressErrorToast: true }` — a real, deliberate opt-out that the literal
 * text `meta: OWN_ERROR_TOAST` does not itself contain. Without this, the
 * scan would flag three correct mutations for sharing their opt-out instead
 * of repeating it. Resolution goes exactly one hop: a constant whose OWN
 * value is a second identifier is not something today's tree does, so the
 * scan does not chase further than that.
 *
 * @param fileText - The whole file, to look up an identifier's declaration in.
 * @param metaValue - The captured value that followed `meta:`.
 */
function metaHasEscapeHatch(fileText: string, metaValue: string): boolean {
  if (META_ESCAPE_HATCH.test(metaValue)) return true;
  const identifier = metaValue.trim().match(/^[A-Za-z_$][\w$]*$/);
  if (!identifier) return false;
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${identifier[0]}\\s*=`).exec(fileText);
  if (!declaration) return false;
  const declaredValue = extractBalancedValue(fileText, declaration.index + declaration[0].length);
  return META_ESCAPE_HATCH.test(declaredValue);
}

/**
 * Every `useMutation({ onError: ... })` in `fileText` that toasts from
 * `onError` without declaring either escape hatch on the same options object.
 *
 * @param filePath - Only used to label the returned violations.
 * @param fileText - The file's source text.
 */
function findViolations(filePath: string, fileText: string): string[] {
  const violations: string[] = [];
  const callSite = /useMutation\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callSite.exec(fileText))) {
    const optionsText = extractBalancedValue(fileText, match.index + match[0].length);
    const onErrorIdx = optionsText.indexOf('onError:');
    if (onErrorIdx === -1) continue;
    const onErrorValue = extractBalancedValue(optionsText, onErrorIdx + 'onError:'.length);
    if (!TOAST_CALL.test(onErrorValue)) continue;

    const metaIdx = optionsText.indexOf('meta:');
    const metaValue =
      metaIdx === -1 ? '' : extractBalancedValue(optionsText, metaIdx + 'meta:'.length);
    if (metaIdx !== -1 && metaHasEscapeHatch(fileText, metaValue)) continue;

    const line = fileText.slice(0, match.index).split('\n').length;
    violations.push(`${filePath}:${line}`);
  }
  return violations;
}

/** Every source file under `apps/client/src`, tests excluded. */
function sourceFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') return [];
      return sourceFiles(full, `${prefix}${entry}/`);
    }
    if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) return [];
    return [`${prefix}${entry}`];
  });
}

describe('the detector itself', () => {
  it('flags a plain onError toast with no meta at all', () => {
    const snippet = `
      export function useX() {
        return useMutation({
          mutationFn: doIt,
          onError: (err) => toast.error(err.message),
        });
      }
    `;
    expect(findViolations('fixture.ts', snippet)).toEqual(['fixture.ts:3']);
  });

  it('does not flag a block-bodied onError that never toasts', () => {
    const snippet = `
      useMutation({
        onError: (_err, _vars, ctx) => {
          if (ctx?.previous) restore(ctx.previous);
        },
      });
    `;
    expect(findViolations('fixture.ts', snippet)).toEqual([]);
  });

  it('does not flag onError toasting when the SAME call declares errorLabel', () => {
    const snippet = `
      useMutation({
        onError: () => toast.error('Could not save'),
        meta: { errorLabel: "Couldn't save that" },
      });
    `;
    expect(findViolations('fixture.ts', snippet)).toEqual([]);
  });

  it('does not flag onError toasting when the SAME call declares suppressErrorToast', () => {
    const snippet = `
      useMutation({
        onError: (err) => toast.error(err.message),
        meta: { suppressErrorToast: true },
      });
    `;
    expect(findViolations('fixture.ts', snippet)).toEqual([]);
  });

  it('resolves meta through one named constant (the OWN_ERROR_TOAST shape)', () => {
    const snippet = `
      const OWN_ERROR_TOAST = { suppressErrorToast: true };
      useMutation({
        onError: (error) => toast.error(getErrorMessage(error)),
        meta: OWN_ERROR_TOAST,
      });
    `;
    expect(findViolations('fixture.ts', snippet)).toEqual([]);
  });

  it('still flags a bare identifier meta that does not resolve to an escape hatch', () => {
    const snippet = `
      const SOME_OTHER_FLAG = { streamOwned: true };
      useMutation({
        onError: (error) => toast.error(error.message),
        meta: SOME_OTHER_FLAG,
      });
    `;
    expect(findViolations('fixture.ts', snippet)).toEqual(['fixture.ts:3']);
  });

  it('follows an implicit-return arrow (no braces) to its true end', () => {
    // The shape `use-tours.ts` shipped with — the onError value ends at the
    // options object's own comma, not at the first `)` inside `toast.error(`.
    const snippet = `
      useMutation({
        mutationFn: save,
        onError: () => toast.error('Could not save your tour progress.'),
      });
    `;
    expect(findViolations('fixture.ts', snippet)).toEqual(['fixture.ts:2']);
  });

  it('is not confused by nested brackets and string braces inside the handler', () => {
    const snippet = `
      useMutation({
        onError: (err, vars) => {
          const keys = Object.keys(vars ?? {}).join(', ');
          toast.error(\`Failed to save (\${keys})\`);
        },
      });
    `;
    expect(findViolations('fixture.ts', snippet)).toEqual(['fixture.ts:2']);
  });

  it('finds two independent violations in the same file at their own lines', () => {
    const snippet = `
      useMutation({ onError: () => toast.error('first') });

      useMutation({ onError: () => toast.error('second') });
    `;
    expect(findViolations('fixture.ts', snippet)).toEqual(['fixture.ts:2', 'fixture.ts:4']);
  });
});

describe('the real tree', () => {
  const files = sourceFiles(SRC_DIR);

  it('actually scanned something', () => {
    // A scan that silently walked zero files would make the assertion below
    // vacuous — this is the floor `one-create-surface.test.ts` also pins.
    expect(files.length).toBeGreaterThan(500);
  });

  it('has no useMutation onError that toasts without meta.errorLabel or meta.suppressErrorToast', () => {
    const violations = files.flatMap((file) =>
      findViolations(file, readFileSync(join(SRC_DIR, file), 'utf8'))
    );
    expect(violations).toEqual([]);
  });
});
