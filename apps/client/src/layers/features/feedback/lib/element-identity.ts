/**
 * Name the thing a person pointed at, so a bug report says WHICH button rather
 * than "the button" (feedback-attachments decision 9).
 *
 * A cropped screenshot shows what was wrong; it does not say what the element is
 * called in the code. These few lines do — a CSS selector short enough to paste
 * into a devtools console, plus whichever of `data-slot` and `data-testid` the
 * element already carries, which are the two names the codebase itself uses to
 * talk about a component's parts.
 *
 * **The DOM is the only input.** No React fiber walking: the internal fiber
 * fields are private, differ between development and production builds, and are
 * renamed without notice — a "component name" read out of them is a value that
 * silently becomes wrong. Attributes that are in the rendered HTML are the
 * durable half, and they are the half a person can go and find again.
 *
 * @module features/feedback/lib/element-identity
 */

/**
 * Longest selector this will build before it gives up on being precise.
 *
 * A selector is only useful if a person can read it. Past roughly this length
 * the nth-of-type chain has stopped identifying anything a human recognises and
 * has become noise in the middle of a bug report, so the walk stops and hands
 * back the best it had.
 */
export const MAX_SELECTOR_LEN = 240;

/**
 * Where the walk up the tree stops.
 *
 * `#root` is the app's mount point, and everything above it (`<body>`, `<html>`)
 * is the same in every report — adding it lengthens the selector and identifies
 * nothing.
 */
const APP_ROOT_ID = 'root';

/** What we can say about the element a person pointed at. */
export interface ElementIdentity {
  /** A CSS selector for the element — as short as it can be while still matching only it. */
  selector: string;
  /** The nearest `data-slot` name, when the element or an ancestor carries one. */
  slot?: string;
  /** The nearest `data-testid`, when the element or an ancestor carries one. */
  testId?: string;
}

/**
 * Escape a string for use inside a CSS selector.
 *
 * `CSS.escape` is the correct answer and every browser this app runs in has it;
 * the fallback exists because a test environment may not, and a missing global
 * must not take the whole identity down with it.
 *
 * @param value - The raw identifier or attribute value.
 */
function escapeForSelector(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["'\\[\]]/g, (char) => `\\${char}`);
}

/** Whether a selector matches this element and nothing else in the document. */
function matchesOnly(selector: string, element: Element): boolean {
  try {
    const found = element.ownerDocument.querySelectorAll(selector);
    return found.length === 1 && found[0] === element;
  } catch {
    // A selector we built ourselves should always parse, but an exotic attribute
    // value that escaped badly must degrade to "not unique" rather than throw
    // out of a bug report.
    return false;
  }
}

/** The `#id` selector for an element, when it has an id worth using. */
function idSelector(element: Element): string | null {
  return element.id ? `#${escapeForSelector(element.id)}` : null;
}

/** An `[attr="value"]` selector for one of the element's naming attributes. */
function attributeSelector(element: Element, attribute: string): string | null {
  const value = element.getAttribute(attribute);
  return value ? `[${attribute}="${escapeForSelector(value)}"]` : null;
}

/**
 * The element's position among its siblings of the same tag, 1-based — the
 * last-resort segment for an element carrying no name of its own.
 */
function nthOfType(element: Element): number {
  const tag = element.tagName;
  let index = 1;
  let sibling = element.previousElementSibling;
  while (sibling) {
    if (sibling.tagName === tag) index += 1;
    sibling = sibling.previousElementSibling;
  }
  return index;
}

/**
 * One segment of a selector path: the most specific name this element carries.
 *
 * The order is the order of durability — an id is unique by contract, a testid
 * is written to be stable, a slot names a component's part, and a position in
 * the sibling list is what is left when the element is anonymous.
 *
 * A name is only allowed to STAND IN for the position when it actually tells the
 * element apart from its siblings. A list of rows carries the same testid on
 * every row by design, and a segment that matches all of them makes a path that
 * can never become unique however far up the tree the walk climbs.
 */
function segmentFor(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const byId = idSelector(element);
  if (byId) return byId;
  const named =
    attributeSelector(element, 'data-testid') ?? attributeSelector(element, 'data-slot');
  const position = `:nth-of-type(${nthOfType(element)})`;
  if (!named) return `${tag}${position}`;
  const segment = `${tag}${named}`;
  const siblings = element.parentElement
    ? Array.from(element.parentElement.children).filter((child) => child.matches(segment))
    : [element];
  return siblings.length === 1 ? segment : `${segment}${position}`;
}

/**
 * Build the shortest selector that matches this element and nothing else.
 *
 * Tries the two names that are unique on their own first, then walks up from the
 * element adding one ancestor at a time and stopping the moment the path has
 * become unambiguous — so a well-labelled element gets a one-segment selector
 * and only an anonymous one deep in a generic tree pays for the whole chain.
 *
 * @param element - The element to name.
 * @returns A CSS selector, at most {@link MAX_SELECTOR_LEN} characters. Unique
 *   whenever the DOM allows it; a best-effort path when it does not.
 */
export function buildSelector(element: Element): string {
  for (const candidate of [idSelector(element), attributeSelector(element, 'data-testid')]) {
    if (candidate && matchesOnly(candidate, element)) return candidate;
  }

  const parts: string[] = [];
  let node: Element | null = element;
  while (node && node.id !== APP_ROOT_ID && node.tagName !== 'BODY') {
    parts.unshift(segmentFor(node));
    const candidate = parts.join(' > ');
    if (candidate.length > MAX_SELECTOR_LEN) {
      // Already past readable, and each further ancestor only makes it longer.
      // Drop back to the last version that fit rather than returning a wall.
      parts.shift();
      break;
    }
    if (matchesOnly(candidate, element)) return candidate;
    node = node.parentElement;
  }

  // Nothing unique was reachable (or the walk ran out of tree). The path we have
  // still points at the right shape, which beats saying nothing.
  return parts.join(' > ') || element.tagName.toLowerCase();
}

/**
 * The value of a naming attribute at or above an element.
 *
 * Looks upward rather than only at the target, because a click lands on whatever
 * leaf is under the pointer — the `<span>` inside a button, the `<svg>` inside
 * that — while the name that means something is on the component's own element,
 * usually one or two hops up.
 *
 * @param element - Where to start looking.
 * @param attribute - The attribute to find.
 */
function nearestAttribute(element: Element, attribute: string): string | undefined {
  return element.closest(`[${attribute}]`)?.getAttribute(attribute) ?? undefined;
}

/**
 * Describe the element a person pointed at.
 *
 * @param element - The element under the pointer when they clicked.
 * @returns Its selector, and whichever of the two naming attributes it has.
 */
export function describeElement(element: Element): ElementIdentity {
  const slot = nearestAttribute(element, 'data-slot');
  const testId = nearestAttribute(element, 'data-testid');
  return {
    selector: buildSelector(element),
    ...(slot ? { slot } : {}),
    ...(testId ? { testId } : {}),
  };
}

/**
 * The identity as the block of lines that rides along in a bug report.
 *
 * Only the lines that resolved: a bug report with `Slot: undefined` in it is
 * worse than one without the line, because a reader has to work out whether the
 * word is the answer or the absence of one.
 *
 * @param identity - What {@link describeElement} found.
 * @returns One line per name, newest-style plain labels, no trailing newline.
 */
export function formatElementIdentity(identity: ElementIdentity): string {
  return [
    `Element: ${identity.selector}`,
    identity.slot ? `Slot: ${identity.slot}` : null,
    identity.testId ? `Testid: ${identity.testId}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/**
 * Fold the identity block into the message the person is writing.
 *
 * Appended to the MESSAGE rather than hidden in diagnostics, and that is a
 * deliberate pair of choices. Diagnostics is a checkbox someone can turn off,
 * which would silently drop the one fact this whole gesture exists to collect;
 * and the message is the field they can read and edit before pressing Send,
 * which is what "you see exactly what you are sending" means here.
 *
 * @param message - What the person has typed so far, possibly empty.
 * @param identity - What {@link describeElement} found.
 * @returns The message with the identity block appended, separated by a blank line.
 */
export function appendElementIdentity(message: string, identity: ElementIdentity): string {
  const block = formatElementIdentity(identity);
  const existing = message.trimEnd();
  return existing ? `${existing}\n\n${block}` : block;
}
