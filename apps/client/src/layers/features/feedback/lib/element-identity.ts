/**
 * Name the thing a person pointed at, so a bug report says WHICH button rather
 * than "the button" (feedback-attachments decision 9).
 *
 * A cropped screenshot shows what was wrong; it does not say what the element is
 * called in the code. This does — a CSS selector short enough to paste into a
 * devtools console, plus whichever of `data-slot` and `data-testid` the element
 * already carries, which are the two names the codebase itself uses to talk
 * about a component's parts. It travels as the submission's own `element` field,
 * never as lines in the message (DOR-2232), and {@link nameElement} gives the
 * plain name the form shows.
 *
 * **The DOM is the only input.** No React fiber walking: the internal fiber
 * fields are private, differ between development and production builds, and are
 * renamed without notice — a "component name" read out of them is a value that
 * silently becomes wrong. Attributes that are in the rendered HTML are the
 * durable half, and they are the half a person can go and find again.
 *
 * @module features/feedback/lib/element-identity
 */
import {
  MAX_FEEDBACK_ELEMENT_LABEL_LEN,
  MAX_FEEDBACK_ELEMENT_NAME_LEN,
  MAX_FEEDBACK_ELEMENT_SELECTOR_LEN,
  type FeedbackElement,
} from '@dorkos/shared/telemetry-events';

/**
 * Longest selector this will build before it gives up on being precise.
 *
 * A selector is only useful if a person can read it. Past roughly this length
 * the nth-of-type chain has stopped identifying anything a human recognises and
 * has become noise in the middle of a bug report, so the walk stops and hands
 * back the best it had. It is also the wire's own cap on the field, so a
 * selector built here is never one the submission schema refuses.
 */
export const MAX_SELECTOR_LEN = MAX_FEEDBACK_ELEMENT_SELECTOR_LEN;

/**
 * Where the walk up the tree stops.
 *
 * `#root` is the app's mount point, and everything above it (`<body>`, `<html>`)
 * is the same in every report — adding it lengthens the selector and identifies
 * nothing.
 */
const APP_ROOT_ID = 'root';

/**
 * What we can say about the element a person pointed at: a CSS selector as short
 * as it can be while still matching only it, and the nearest `data-slot` and
 * `data-testid` at or above it. The same shape the submission carries as its
 * `element` field, so it goes on the wire as it is.
 */
export type ElementIdentity = FeedbackElement;

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
    // A unique name is still no use if it is a wall of text, and the wire
    // refuses one past the cap. The walk below keeps to the cap on its own.
    if (candidate && candidate.length <= MAX_SELECTOR_LEN && matchesOnly(candidate, element)) {
      return candidate;
    }
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
  const value = element.closest(`[${attribute}]`)?.getAttribute(attribute);
  // The names the codebase writes are a few words long. A value past the wire's
  // cap is not one of them, and cutting it would report a name nobody wrote, so
  // it is left out and the selector still says which element it was.
  if (!value || value.length > MAX_FEEDBACK_ELEMENT_NAME_LEN) return undefined;
  return value;
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
  const label = accessibleLabel(element);
  return {
    selector: buildSelector(element),
    ...(slot ? { slot } : {}),
    ...(testId ? { testId } : {}),
    ...(label ? { label } : {}),
  };
}

/**
 * The longest label shown for an element before it is cut at a word. A name is
 * for recognising the thing, and a chip's words fit well inside this; a card's
 * whole paragraph does not, and is not what anyone would call it.
 */
export const MAX_LABEL_LEN = 40;

/**
 * What counts as a control: the thing a click on its icon or its inner text was
 * really aimed at, and whose words are its name.
 */
const CONTROL_SELECTOR = [
  'button',
  'a[href]',
  'summary',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="switch"]',
].join(', ');

/** Fields whose content is what a person typed, never a name to send. */
const FIELD_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

/**
 * Surfaces whose text is what a person typed or what was said, not a name: a
 * rich-text editor (the composer draws a draft as `<p><span data-lexical-text>`,
 * CodeMirror as its own lines) and anything announcing itself as a text box.
 * An element in one of these is named by its host's `aria-label` or nothing —
 * never by its words, which could be a half-written message.
 */
const EDITABLE_SELECTOR = [
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
].join(', ');

/**
 * Elements whose own text IS a name, outside any control: headings, labels, a
 * table's header cells, a definition's term. Everything else's text is content
 * — a line of a sent message is as short as any name, and still not one.
 */
const NAME_TEXT_SELECTOR = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  '[role="heading"]',
  'label',
  'legend',
  'th',
  'dt',
].join(', ');

/**
 * Split text into what a reader sees as characters, so a cut never lands inside
 * an emoji or between a surrogate pair. Code points where `Intl.Segmenter` is
 * missing, which still never leaves a lone surrogate.
 */
function characters(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

/** Collapse whitespace and cut at a word near {@link MAX_LABEL_LEN}, or `undefined` when empty. */
function shorten(raw: string | null | undefined): string | undefined {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const chars = characters(text);
  if (chars.length <= MAX_LABEL_LEN) return text;
  const cut = chars.slice(0, MAX_LABEL_LEN - 1);
  const atWord = cut.lastIndexOf(' ');
  const kept = atWord > MAX_LABEL_LEN / 2 ? cut.slice(0, atWord) : cut;
  return `${kept.join('').trimEnd()}…`;
}

/** The text of the elements an `aria-labelledby` points at. */
function labelledByText(element: Element): string | undefined {
  const ids = element.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean) ?? [];
  const text = ids
    .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
    .join(' ');
  return shorten(text);
}

/** An element's own name: `aria-label`, then `aria-labelledby`. */
function ariaName(element: Element): string | undefined {
  return shorten(element.getAttribute('aria-label')) ?? labelledByText(element);
}

/**
 * The words a person sees on the element: its accessible name, trimmed.
 *
 * In order:
 * - Inside an editable surface (a draft in the composer, a code editor, any
 *   text box), only the host's `aria-label`/`aria-labelledby`. Never its text:
 *   that is what somebody typed.
 * - Inside a control (the button around a clicked icon), the control's
 *   `aria-label`, `aria-labelledby`, then its text. A form field is named only
 *   by its label, never by its value.
 * - Otherwise its own `aria-label`/`aria-labelledby`, or the text of the
 *   heading, label, legend, table header or term it sits in. Plain text is
 *   content — a short line of a sent message is not a name.
 *
 * @param element - The element under the pointer.
 * @returns The name, at most about {@link MAX_LABEL_LEN} characters, or `undefined`.
 */
export function accessibleLabel(element: Element): string | undefined {
  const label = findLabel(element);
  return label && label.length <= MAX_FEEDBACK_ELEMENT_LABEL_LEN ? label : undefined;
}

/** The unbounded search behind {@link accessibleLabel}. */
function findLabel(element: Element): string | undefined {
  const editable = element.closest(EDITABLE_SELECTOR);
  if (editable) return ariaName(editable);

  const control = element.closest(CONTROL_SELECTOR);
  if (control) {
    if (FIELD_TAGS.has(control.tagName)) {
      const field = control as HTMLInputElement;
      return ariaName(control) ?? shorten(field.labels?.[0]?.textContent);
    }
    return ariaName(control) ?? shorten(control.textContent);
  }

  const own = ariaName(element);
  if (own) return own;
  const named = element.closest(NAME_TEXT_SELECTOR);
  return named ? shorten(named.textContent) : undefined;
}

/**
 * Turn a code name into words: split on dashes, underscores and camel case, and
 * give it a capital. `message-list` and `messageList` both read "Message list".
 *
 * @param raw - A `data-testid` or `data-slot` value.
 * @returns The words, or `null` when there are none.
 */
export function humanizeName(raw: string): string | null {
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.length === 0) return null;
  const sentence = words.join(' ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * A plain name for the element, for a person to read: the thumbnail's caption
 * and the question the message box asks ("What's wrong with Set up a daily
 * run?").
 *
 * Closest-first, because the nearest name is the most specific one:
 * 1. its accessible name — the words on it (see {@link accessibleLabel});
 * 2. its OWN `data-testid`, then its own `data-slot`;
 * 3. the nearest ancestor's, testid before slot on the same element.
 *
 * Reading the nearest `data-slot` first is what once named a starter chip "App
 * shell": the chip had no slot of its own, and the shell around everything did.
 *
 * @param element - The element under the pointer, read at the moment it was clicked.
 * @returns The name, or `null` when nothing names it. The caller picks its own
 *   words for that case, because "this part" reads differently in a caption
 *   than in a question.
 */
export function nameElement(element: Element): ElementName | null {
  const label = accessibleLabel(element);
  if (label) return { text: label, onScreen: true };
  const own = element.getAttribute('data-testid') ?? element.getAttribute('data-slot');
  const ownName = own ? humanizeName(own) : null;
  if (ownName) return { text: ownName, onScreen: false };
  const holder = element.parentElement?.closest('[data-testid], [data-slot]');
  const inherited = holder?.getAttribute('data-testid') ?? holder?.getAttribute('data-slot');
  const inheritedName = inherited ? humanizeName(inherited) : null;
  return inheritedName ? { text: inheritedName, onScreen: false } : null;
}

/** What {@link nameElement} found, and where the words came from. */
export interface ElementName {
  /** The name, ready to show. */
  text: string;
  /**
   * Whether these are words printed on the element ("Set up a daily run"),
   * which read as a quote, rather than a code name turned into words ("Message
   * list"), which reads as a noun.
   */
  onScreen: boolean;
}
