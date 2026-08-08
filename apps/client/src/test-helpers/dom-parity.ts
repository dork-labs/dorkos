/**
 * Serialized-DOM parity — prove a refactor did not move the markup.
 *
 * A restructure that only re-homes JSX should render byte-for-byte the same
 * tree. Asserting that with `toMatchSnapshot()` over `innerHTML` does not work
 * here for one reason: `cn()` composes class strings, and moving a `className`
 * from a caller into a wrapper legitimately reorders its tokens without moving
 * a single pixel. A raw string compare calls that a failure, so the author
 * re-records the snapshot — and the snapshot stops being evidence.
 *
 * So this serializes the tree into a normalized shape and diffs it
 * structurally. The normalization is deliberately narrow, and the list is
 * closed:
 *
 * - `class` compares as a token SET. Reordering is equal; a token added or
 *   removed is a real difference and is reported as one.
 * - `motion`-generated `style` transform values are placeholder-substituted —
 *   the property still appears, only its value is erased, so a NEW transform is
 *   still a difference.
 * - `useId`-derived fragments inside `id` and `aria-*` values are
 *   placeholder-substituted in place. `id="«r7»-listbox"` and `id="«r3»-listbox"`
 *   are equal; `id="«r7»-listbox"` and `id="«r7»-menu"` are not.
 *
 * Everything else — element names, nesting, sibling order, text, `data-testid`,
 * `role`, `aria-label`, `placeholder`, `disabled` — compares literally.
 *
 * Baselines are checked-in JSON captured from the PRE-migration component. A
 * baseline recorded after the change proves nothing, which is why
 * {@link matchDomBaseline} refuses to invent a missing one: recording is an
 * explicit act, gated on `DORKOS_RECORD_DOM_BASELINE=1`.
 *
 * @module test-helpers/dom-parity
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A serialized element: its tag, its class token set, its other attributes, its children. */
export interface SerializedElement {
  readonly kind: 'element';
  /** Lower-cased tag name. */
  readonly tag: string;
  /** `class` tokens, deduplicated and sorted — a SET, so `cn()` reordering is not a difference. */
  readonly classes: readonly string[];
  /** Every attribute except `class`, key-sorted, values normalized. */
  readonly attrs: Readonly<Record<string, string>>;
  /** Child nodes in document order. Comments are dropped; text is kept verbatim. */
  readonly children: readonly SerializedNode[];
}

/** A serialized text node. Whitespace is kept exactly as rendered. */
export interface SerializedText {
  readonly kind: 'text';
  readonly text: string;
}

/** One node of a serialized subtree. */
export type SerializedNode = SerializedElement | SerializedText;

/** What kind of difference the differ found. */
export type DomDiffKind =
  | 'tag'
  | 'class-added'
  | 'class-removed'
  | 'attr-added'
  | 'attr-removed'
  | 'attr-changed'
  | 'node-added'
  | 'node-removed'
  | 'node-kind'
  | 'text';

/** One reported difference between a baseline tree and an actual tree. */
export interface DomDiffEntry {
  /** Where it is, as a readable node path (`div > div[1] > textarea`). */
  readonly path: string;
  readonly kind: DomDiffKind;
  /** The difference in words, baseline-first. */
  readonly detail: string;
}

/**
 * Style properties `motion` writes imperatively during an animation. Their
 * VALUES are erased; the property names stay, so a transform that appears where
 * there was none is still reported.
 */
const MOTION_STYLE_PROPERTIES = new Set([
  'transform',
  'transform-origin',
  'transform-box',
  'translate',
  'rotate',
  'scale',
  'perspective',
  'perspective-origin',
  'will-change',
]);

/** Stands in for an erased `motion` transform value. */
const MOTION_VALUE_PLACEHOLDER = '<motion>';

/** Stands in for an erased `useId` fragment. */
const USE_ID_PLACEHOLDER = '<useId>';

/**
 * The shapes React's `useId` has emitted across versions — `«r0»` (19),
 * `:r0:` (18), and the `_r_0_` form the compiler-friendly build produces.
 * Matched as a SUBSTRING so composed ids keep their literal parts: only the
 * generated fragment of `«r7»-listbox` is erased.
 */
const USE_ID_PATTERN = /«[^»]*»|:[A-Za-z0-9]+:|_r_[a-z0-9]+_/g;

/** Erase generated `useId` fragments, keeping every literal part of the value. */
function normalizeGeneratedIds(value: string): string {
  return value.replace(USE_ID_PATTERN, USE_ID_PLACEHOLDER);
}

/** Erase `motion`'s animated transform values while keeping the property names. */
function normalizeStyle(value: string): string {
  return value
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration !== '')
    .map((declaration) => {
      const colon = declaration.indexOf(':');
      if (colon === -1) return declaration;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const isMotionWritten =
        MOTION_STYLE_PROPERTIES.has(property) || property.startsWith('--motion-');
      if (!isMotionWritten) return declaration;
      return `${property}: ${MOTION_VALUE_PLACEHOLDER}`;
    })
    .join('; ');
}

/** Apply the closed normalization list to one attribute value. */
function normalizeAttributeValue(name: string, value: string): string {
  if (name === 'style') return normalizeStyle(value);
  if (name === 'id' || name.startsWith('aria-')) return normalizeGeneratedIds(value);
  return value;
}

/** Split a `class` attribute into a deduplicated, sorted token list. */
function classTokens(element: Element): string[] {
  const raw = element.getAttribute('class');
  if (raw === null) return [];
  return [...new Set(raw.split(/\s+/).filter((token) => token !== ''))].sort();
}

/**
 * Serialize an element and everything under it into the normalized shape
 * {@link diffDom} compares.
 *
 * Pass Testing Library's `container` rather than a component root when the tree
 * could have more than one root element — the container is a bare `<div>` with
 * no attributes, so including it costs nothing and a second root cannot hide.
 */
export function serializeDom(root: Element): SerializedElement {
  const attrs: Record<string, string> = {};
  for (const name of [...root.getAttributeNames()].sort()) {
    if (name === 'class') continue;
    attrs[name] = normalizeAttributeValue(name, root.getAttribute(name) ?? '');
  }

  const children: SerializedNode[] = [];
  for (const node of root.childNodes) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      children.push(serializeDom(node as Element));
    } else if (node.nodeType === Node.TEXT_NODE) {
      children.push({ kind: 'text', text: node.textContent ?? '' });
    }
    // Comment nodes carry no rendered meaning and are dropped.
  }

  return {
    kind: 'element',
    tag: root.tagName.toLowerCase(),
    classes: classTokens(root),
    attrs,
    children,
  };
}

/** A node's step in a diff path — the tag, plus its sibling index when it has siblings. */
function pathStep(node: SerializedNode, index: number, siblingCount: number): string {
  const label = node.kind === 'element' ? node.tag : '#text';
  return siblingCount > 1 ? `${label}[${index}]` : label;
}

/** Walk two serialized trees in parallel, appending every difference found. */
function walk(
  baseline: SerializedNode,
  actual: SerializedNode,
  path: string,
  out: DomDiffEntry[]
): void {
  if (baseline.kind !== actual.kind) {
    out.push({
      path,
      kind: 'node-kind',
      detail: `baseline has a ${baseline.kind} node, actual has a ${actual.kind} node`,
    });
    return;
  }

  if (baseline.kind === 'text' && actual.kind === 'text') {
    if (baseline.text !== actual.text) {
      out.push({
        path,
        kind: 'text',
        detail: `text ${JSON.stringify(baseline.text)} -> ${JSON.stringify(actual.text)}`,
      });
    }
    return;
  }

  const before = baseline as SerializedElement;
  const after = actual as SerializedElement;

  if (before.tag !== after.tag) {
    out.push({ path, kind: 'tag', detail: `<${before.tag}> -> <${after.tag}>` });
    // Tags differing makes any deeper comparison noise; the swap is the finding.
    return;
  }

  const baselineClasses = new Set(before.classes);
  const actualClasses = new Set(after.classes);
  for (const token of before.classes) {
    if (!actualClasses.has(token)) {
      out.push({ path, kind: 'class-removed', detail: `class token "${token}" removed` });
    }
  }
  for (const token of after.classes) {
    if (!baselineClasses.has(token)) {
      out.push({ path, kind: 'class-added', detail: `class token "${token}" added` });
    }
  }

  for (const name of Object.keys(before.attrs).sort()) {
    if (!(name in after.attrs)) {
      out.push({
        path,
        kind: 'attr-removed',
        detail: `attribute ${name}="${before.attrs[name]}" removed`,
      });
    } else if (before.attrs[name] !== after.attrs[name]) {
      out.push({
        path,
        kind: 'attr-changed',
        detail: `attribute ${name}: "${before.attrs[name]}" -> "${after.attrs[name]}"`,
      });
    }
  }
  for (const name of Object.keys(after.attrs).sort()) {
    if (!(name in before.attrs)) {
      out.push({
        path,
        kind: 'attr-added',
        detail: `attribute ${name}="${after.attrs[name]}" added`,
      });
    }
  }

  const shared = Math.min(before.children.length, after.children.length);
  for (let i = 0; i < shared; i++) {
    const step = pathStep(
      before.children[i]!,
      i,
      Math.max(before.children.length, after.children.length)
    );
    walk(before.children[i]!, after.children[i]!, `${path} > ${step}`, out);
  }
  for (let i = shared; i < before.children.length; i++) {
    const child = before.children[i]!;
    out.push({
      path: `${path} > ${pathStep(child, i, before.children.length)}`,
      kind: 'node-removed',
      detail: `${describe(child)} removed`,
    });
  }
  for (let i = shared; i < after.children.length; i++) {
    const child = after.children[i]!;
    out.push({
      path: `${path} > ${pathStep(child, i, after.children.length)}`,
      kind: 'node-added',
      detail: `${describe(child)} added`,
    });
  }
}

/** One line naming a node, for the added/removed reports. */
function describe(node: SerializedNode): string {
  if (node.kind === 'text') return `text ${JSON.stringify(node.text)}`;
  const classes = node.classes.length > 0 ? `.${node.classes.join('.')}` : '';
  return `<${node.tag}${classes}>`;
}

/**
 * Diff two serialized trees. An empty array means the DOM is unchanged under
 * the normalization above.
 */
export function diffDom(baseline: SerializedNode, actual: SerializedNode): DomDiffEntry[] {
  const out: DomDiffEntry[] = [];
  walk(baseline, actual, baseline.kind === 'element' ? baseline.tag : '#text', out);
  return out;
}

/**
 * Render a diff for a failure message. Returns `''` for an empty diff, so a
 * test can assert `expect(formatDomDiff(diff)).toBe('')` and read the whole
 * difference in the failure output instead of a node count.
 */
export function formatDomDiff(diff: readonly DomDiffEntry[]): string {
  return diff.map((entry) => `${entry.path}: [${entry.kind}] ${entry.detail}`).join('\n');
}

/** Set this to `1` to re-record baselines. See the module doc before you do. */
const RECORD_ENV_VAR = 'DORKOS_RECORD_DOM_BASELINE';

/**
 * Where a named baseline lives: `__baselines__/<name>.json`, beside the test
 * that owns it.
 *
 * Callers pass their own `import.meta.url` so the path follows the test file
 * wherever it moves. It is deliberately NOT the `new URL(rel, import.meta.url)`
 * idiom: Vite rewrites that expression into a served asset URL
 * (`http://localhost:3000/...`), which is not a path any filesystem call can
 * take.
 */
export function domBaselinePath(moduleUrl: string, name: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), '__baselines__', `${name}.json`);
}

/**
 * Compare a freshly serialized tree against its checked-in baseline.
 *
 * A missing baseline THROWS rather than recording one. The baseline's whole
 * value is that it predates the change under test; a file this call could
 * create on demand would only ever record whatever the current code emits.
 * Recording is opt-in via `DORKOS_RECORD_DOM_BASELINE=1`, and belongs on the
 * commit BEFORE the migration.
 *
 * @param moduleUrl The calling test's `import.meta.url`.
 * @param name Baseline file name, without the `.json`.
 * @param actual The freshly serialized tree.
 */
export function matchDomBaseline(
  moduleUrl: string,
  name: string,
  actual: SerializedNode
): DomDiffEntry[] {
  const path = domBaselinePath(moduleUrl, name);

  // `env.ts` is the BROWSER's env, validated at app boot. This is a test-only,
  // node-side escape hatch that never appears in a bundle, and routing it
  // through the app's env would put a recording switch in the shipped schema.
  // eslint-disable-next-line no-restricted-syntax -- see above
  if (process.env[RECORD_ENV_VAR] === '1') {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
    return [];
  }

  if (!existsSync(path)) {
    throw new Error(
      `No DOM baseline at ${path}.\n` +
        `Baselines are captured from the PRE-migration component and committed with it. ` +
        `If you are capturing one now, and the component has NOT yet changed, re-run with ` +
        `${RECORD_ENV_VAR}=1.`
    );
  }

  return diffDom(JSON.parse(readFileSync(path, 'utf8')) as SerializedNode, actual);
}
