/// <reference lib="dom" />
/**
 * The driving half of the in-page shim (spec `canvas-agent-seat` §2) — clicking,
 * typing, pressing, scrolling, waiting and reading a preview back.
 *
 * ## Why it lives here and not in `devtools-shim.ts`
 *
 * Same reason `serializeConsoleArg` does: {@link installBrowserDriving} is a
 * real, typechecked, linted function that the shim embeds by
 * `Function.prototype.toString()`, so it must reference **no module-scope
 * binding** — everything it needs arrives as a parameter or is a browser global.
 * Keeping it in its own file keeps both files readable and keeps the rule
 * obvious: if you reach for an import inside this function, the emitted script
 * breaks in a browser and only a page test will tell you.
 *
 * ## What it may talk to
 *
 * Nothing but the page and `window.parent`. There is no `/api` reference in this
 * file's shim source and there may never be one — the preview frame has an
 * opaque origin and no credential, which is the whole reason driving is safe to
 * leave on a permission mode (ADR `260708-185519`, ADR `260912-025251`). A test
 * asserts the absence.
 *
 * ## What it is honest about
 *
 * Element resolution is ours, not Playwright's: no auto-waiting, no shadow-DOM
 * piercing, and an accessible name that approximates accname rather than
 * implementing it. The tools' own descriptions say so, so an agent that cannot
 * find something by name is told to fall back to a selector instead of
 * concluding the thing is not there.
 *
 * @module services/workbench-serve/devtools-driving
 */

/** One element route, exactly as the parent sent it. */
interface DrivingTarget {
  role?: string;
  name?: string;
  text?: string;
  selector?: string;
  nth?: number;
}

/** One action for the page, discriminated on `action`. */
interface DrivingCommand {
  action: 'click' | 'type' | 'press' | 'scroll' | 'wait_for' | 'read_page';
  target?: DrivingTarget;
  text?: string;
  clear?: boolean;
  submit?: boolean;
  key?: string;
  by?: number;
  to?: 'top' | 'bottom';
  selector?: string;
  gone?: boolean;
  fetchIdle?: boolean;
  timeoutMs?: number;
  maxChars?: number;
}

/** One request from the parent: do this, and answer under this id. */
export interface DrivingRequest {
  requestId: string;
  documentId?: string;
  command: DrivingCommand;
  /**
   * Keep a picture of what this action left behind (spec `canvas-agent-seat`
   * §3.2). Set only while a recording is running on this page.
   */
  capture?: boolean;
  /** The rasterizer source, delivered by the parent when `capture` is set. */
  lib?: unknown;
}

/** One outline line, before it is joined into the answer. */
export interface OutlineLine {
  /** Indent level, one for a child of the read's root. */
  depth: number;
  /** `role "name" [state]`, already rendered. */
  text: string;
}

/**
 * Join an outline into a budget, losing leaves before structure.
 *
 * Over budget, the DEEPEST lines go first, from the end — so what survives is
 * the shape of the page, and its leaves are what an agent can ask for again
 * with a selector.
 *
 * **One pass, deliberately.** The obvious version drops one line and re-renders
 * the whole outline to measure it again, which is quadratic in the line count:
 * a page a few thousand lines over budget spent longer inside the page than the
 * round trip's own timeout, so the preview froze and the tool reported a
 * timeout that was really this loop. Here every line is measured once and
 * dropped at most once.
 *
 * Exported as a standalone function for two reasons: the shim embeds it by
 * `toString()` like every other piece of itself, and a cost this shape has to
 * be provable at a scale no DOM fixture can reach. Self-contained: it
 * references no module-scope binding.
 *
 * @param header - The `document "…"` line, never dropped.
 * @param lines - Every candidate line, in document order.
 * @param maxChars - The character budget for the whole outline.
 * @returns The joined outline, and whether anything was cut.
 */
export function truncateOutlineLines(
  header: string,
  lines: OutlineLine[],
  maxChars: number
): { outline: string; truncated: boolean } {
  const rendered: string[] = [];
  const lengths: number[] = [];
  let total = header.length;
  let deepest = 0;
  for (const line of lines) {
    const text = '  '.repeat(line.depth) + line.text;
    rendered.push(text);
    lengths.push(text.length + 1); // the newline that joins it on
    total += text.length + 1;
    if (line.depth > deepest) deepest = line.depth;
  }
  if (total <= maxChars) {
    return { outline: [header, ...rendered].join('\n'), truncated: false };
  }
  const dropped: boolean[] = [];
  for (let i = 0; i < rendered.length; i++) dropped.push(false);
  for (let depth = deepest; depth >= 1 && total > maxChars; depth--) {
    for (let i = rendered.length - 1; i >= 0 && total > maxChars; i--) {
      if (dropped[i] || lines[i].depth !== depth) continue;
      dropped[i] = true;
      total -= lengths[i];
    }
  }
  const kept: string[] = [];
  for (let i = 0; i < rendered.length; i++) if (!dropped[i]) kept.push(rendered[i]);
  const text = [header, ...kept].join('\n');
  return { outline: text.length > maxChars ? text.slice(0, maxChars) : text, truncated: true };
}

/** What {@link installBrowserDriving} needs from the shim around it. */
export interface DrivingContext {
  /** Post one message to `window.parent`, swallowing its own failures. */
  post: (message: unknown) => void;
  /** How many `fetch`/XHR calls the shim has started and not yet seen settle. */
  inFlight: () => number;
  /**
   * Rasterize this document once, at the capture size — the shim's own
   * screenshot path, reused for a recording's keyframes.
   */
  rasterize: (lib: unknown) => Promise<string>;
}

/**
 * Build the page's driving handler.
 *
 * Returns the function the shim's `message` listener calls for one
 * `act-request`. Exactly one `act-result` is posted per `requestId`, ever —
 * including when the page navigates out from under the action, which is what the
 * `pagehide` short-circuit below is for.
 *
 * Self-contained: it references no module-scope binding, so its stringified
 * source is complete. Exported both to embed into the shim (via `toString()`)
 * and so a page test can execute it.
 *
 * @param ctx - The shim's `post` and its in-flight request counter.
 * @param truncate - {@link truncateOutlineLines}, passed in as a local binding
 *   for the same reason every other helper is: a stringified function carries no
 *   module scope with it.
 * @returns A handler for one parsed `act-request` message.
 */
export function installBrowserDriving(
  ctx: DrivingContext,
  truncate: (
    header: string,
    lines: OutlineLine[],
    maxChars: number
  ) => { outline: string; truncated: boolean }
): (request: DrivingRequest) => void {
  const MAX_NAME_CHARS = 120;
  const POLL_MS = 50;
  const FETCH_QUIET_MS = 500;
  // How long an action that can move the page waits before reporting where the
  // page ended up. Long enough for a client-side router to paint, short enough
  // that six actions in a row are not a wasted minute.
  const SETTLE_MS = 150;
  // How long a recording frame may hold up the answer it rides on. Rasterizing
  // a page is 1-3 s of real work, and the round trip it is part of gives up at
  // eight; past this the answer goes without a picture rather than late.
  const CAPTURE_BUDGET_MS = 5_000;

  /** Tags that are never part of what a person sees. */
  const SKIPPED_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link']);

  /** Implicit ARIA roles for the tags that actually turn up in a page. */
  const IMPLICIT_ROLES: Record<string, string> = {
    a: 'link',
    article: 'article',
    aside: 'complementary',
    button: 'button',
    dialog: 'dialog',
    footer: 'contentinfo',
    form: 'form',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading',
    header: 'banner',
    img: 'img',
    li: 'listitem',
    main: 'main',
    nav: 'navigation',
    ol: 'list',
    option: 'option',
    output: 'status',
    progress: 'progressbar',
    section: 'region',
    select: 'combobox',
    table: 'table',
    tbody: 'rowgroup',
    td: 'cell',
    textarea: 'textbox',
    th: 'columnheader',
    tr: 'row',
    ul: 'list',
  };

  /** Implicit roles for the `<input type>` values that behave differently. */
  const INPUT_ROLES: Record<string, string> = {
    button: 'button',
    checkbox: 'checkbox',
    email: 'textbox',
    image: 'button',
    number: 'spinbutton',
    password: 'textbox',
    radio: 'radio',
    range: 'slider',
    reset: 'button',
    search: 'searchbox',
    submit: 'button',
    tel: 'textbox',
    text: 'textbox',
    url: 'textbox',
  };

  /** The tags an HTML `<label>` can be attached to; nothing else has `labels`. */
  const LABELABLE_TAGS = new Set([
    'button',
    'input',
    'meter',
    'output',
    'progress',
    'select',
    'textarea',
  ]);

  /**
   * Roles whose accessible name may NOT fall back to their own text.
   *
   * A landmark or a container is named by what somebody CALLED it, never by
   * everything inside it. Without this, `<main>` printed the whole page's text
   * as its name — measured on a real page in `apps/e2e`: `main "Inbox Nothing
   * done yet Mark as done Archive"` sat above the very lines it was repeating,
   * eating the outline's budget to say nothing new.
   */
  const NO_TEXT_NAME_ROLES = new Set([
    'article',
    'banner',
    'complementary',
    'contentinfo',
    'dialog',
    'form',
    'list',
    'main',
    'navigation',
    'region',
    'rowgroup',
    'search',
    'table',
  ]);

  /** Roles that earn an outline line even with no accessible name of their own. */
  const LANDMARK_ROLES = new Set([
    'banner',
    'complementary',
    'contentinfo',
    'form',
    'main',
    'navigation',
    'region',
    'search',
    'alert',
    'status',
    'list',
    'table',
  ]);

  function trim(value: unknown, max = MAX_NAME_CHARS): string {
    const text = String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  function roleOf(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0].toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return INPUT_ROLES[type] || 'textbox';
    }
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : '';
    return IMPLICIT_ROLES[tag] || '';
  }

  /**
   * What a person reading the page would call this thing.
   *
   * `aria-label`, then `aria-labelledby` resolved one level, then a label
   * element, then `alt`, `title`, `placeholder`, then the element's own text.
   * Deliberately not the accname algorithm — see the module doc.
   */
  function nameOf(el: Element): string {
    return nameOfWithRole(el, roleOf(el));
  }

  /**
   * {@link nameOf} with the role already in hand, for the outline walk — which
   * computes the role first anyway and must not compute it twice per node.
   */
  function nameOfWithRole(el: Element, role: string): string {
    const label = el.getAttribute('aria-label');
    if (label && label.trim()) return trim(label);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts: string[] = [];
      for (const id of labelledBy.split(/\s+/)) {
        const target = el.ownerDocument.getElementById(id);
        if (target) parts.push(target.textContent || '');
      }
      const joined = trim(parts.join(' '));
      if (joined) return joined;
    }
    // Only of elements that can HAVE labels. `labels` is a live search of the
    // whole document for a matching `<label for>`, so asking every node for it
    // is quadratic in the page size — 30 000 nodes took minutes, inside a page
    // whose round trip gives it eight seconds. A `<td>` has no labels anyway.
    if (LABELABLE_TAGS.has(el.tagName.toLowerCase())) {
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length > 0) {
        const joined = trim(Array.from(labels, (one) => one.textContent || '').join(' '));
        if (joined) return joined;
      }
    }
    // `value` is deliberately NOT in this chain. A prefilled field would be named
    // by whatever is typed in it, so the name an agent read a moment ago stops
    // matching the moment it types — and two prefilled fields with the same
    // contents would be indistinguishable. A field is named by its label.
    for (const attribute of ['alt', 'title', 'placeholder']) {
      const value = el.getAttribute(attribute);
      if (value && value.trim()) return trim(value);
    }
    if (NO_TEXT_NAME_ROLES.has(role)) return '';
    return trim(el.textContent);
  }

  /**
   * Whether an element is something a person could see and act on.
   *
   * `checkVisibility` when the browser has it, which is every browser a preview
   * renders in. The fallback walks the styles that HIDE things and never reads a
   * rect: an engine with no layout (the test environment) reports every rect as
   * zero, and treating that as "hidden" would make the whole page invisible
   * rather than report the truth.
   */
  function isVisible(el: Element): boolean {
    const withCheck = el as Element & {
      checkVisibility?: (options: Record<string, boolean>) => boolean;
    };
    if (typeof withCheck.checkVisibility === 'function') {
      try {
        return withCheck.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      } catch {
        /* fall through to the style walk */
      }
    }
    let node: Element | null = el;
    while (node) {
      if (!isSelfVisible(node)) return false;
      node = node.parentElement;
    }
    return true;
  }

  /**
   * Whether this element hides ITSELF, ignoring its ancestors.
   *
   * The half the outline walk needs. That walk descends parent-to-child and
   * prunes a hidden subtree, so every ancestor has already been asked — and
   * re-walking the chain per node turns a 10 000-row table into 10 000 chains of
   * `getComputedStyle` calls, which is minutes rather than milliseconds where
   * there is no layout engine to make them cheap.
   */
  function isSelfVisible(el: Element): boolean {
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
    const withCheck = el as Element & {
      checkVisibility?: (options: Record<string, boolean>) => boolean;
    };
    if (typeof withCheck.checkVisibility === 'function') {
      try {
        return withCheck.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      } catch {
        /* fall through to the style read */
      }
    }
    const view = el.ownerDocument.defaultView;
    const style = view && view.getComputedStyle ? view.getComputedStyle(el) : null;
    return !style || (style.display !== 'none' && style.visibility !== 'hidden');
  }

  function isDisabled(el: Element): boolean {
    return (
      (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true'
    );
  }

  /** Every element a person could be talking about, in document order. */
  function allElements(root: ParentNode): Element[] {
    const out: Element[] = [];
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (!SKIPPED_TAGS.has(el.tagName.toLowerCase())) out.push(el);
    }
    return out;
  }

  /** Where the page is now: enough to know without reading it all back. */
  function pageSummary(): { title: string; url: string; focused: string | null } {
    const active = document.activeElement;
    const focused =
      active && active !== document.body
        ? trim(
            (roleOf(active) || active.tagName.toLowerCase()) +
              (nameOf(active) ? ' "' + nameOf(active) + '"' : ''),
            256
          )
        : null;
    return { title: trim(document.title, 512), url: trim(location.href, 2048), focused };
  }

  function describe(el: Element): string {
    const role = roleOf(el) || el.tagName.toLowerCase();
    const name = nameOf(el);
    return name ? role + ' "' + name + '"' : role;
  }

  /**
   * Find the one element a target names, or say why not.
   *
   * The refusals are the point: zero matches names the tool that would show what
   * is there, and several matches with no `nth` refuses rather than guessing
   * which one the agent meant.
   */
  function resolveTarget(
    target: DrivingTarget
  ): { ok: true; el: Element; matched: number } | { ok: false; error: string; matched: number } {
    let found: Element[];
    let described: string;
    if (target.selector) {
      described = 'the selector ' + target.selector;
      try {
        found = Array.from(document.querySelectorAll(target.selector));
      } catch {
        return {
          ok: false,
          matched: 0,
          error: 'That is not a CSS selector this page can use: ' + trim(target.selector, 200),
        };
      }
    } else if (target.role && target.name) {
      described = 'a ' + target.role + ' named "' + target.name + '"';
      const wanted = target.name.trim().toLowerCase();
      const wantedRole = target.role.trim().toLowerCase();
      found = allElements(document).filter(
        (el) => roleOf(el) === wantedRole && nameOf(el).toLowerCase() === wanted
      );
    } else if (target.text) {
      described = 'the text "' + target.text + '"';
      const wanted = target.text.trim().toLowerCase();
      const hits = allElements(document).filter((el) =>
        (el.textContent || '').trim().toLowerCase().includes(wanted)
      );
      // The deepest match only: every ancestor of a matching node "contains" the
      // text too, and clicking <body> is not what anybody meant.
      found = hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
      const exact = found.filter((el) => (el.textContent || '').trim().toLowerCase() === wanted);
      if (exact.length > 0) found = exact;
    } else {
      return {
        ok: false,
        matched: 0,
        error:
          'Name the element one way — a role and name, some visible text, or a CSS selector — not several.',
      };
    }

    const visible = found.filter(isVisible);
    if (visible.length === 0) {
      return {
        ok: false,
        matched: 0,
        error:
          found.length > 0
            ? 'Nothing visible on the page matched ' +
              described +
              '. Call browser_read_page to see what is there.'
            : 'Nothing on the page matched ' +
              described +
              '. Call browser_read_page to see what is there.',
      };
    }
    if (target.nth !== undefined) {
      const picked = visible[target.nth];
      if (!picked) {
        return {
          ok: false,
          matched: visible.length,
          error:
            'There is no match number ' +
            target.nth +
            ' — ' +
            visible.length +
            ' things matched ' +
            described +
            ', counted from 0.',
        };
      }
      return { ok: true, el: picked, matched: visible.length };
    }
    if (visible.length > 1) {
      return {
        ok: false,
        matched: visible.length,
        error:
          visible.length +
          ' things matched ' +
          described +
          '. Pass nth to pick one, or name it more exactly.',
      };
    }
    return { ok: true, el: visible[0], matched: 1 };
  }

  function statesOf(el: Element): string {
    const states: string[] = [];
    if (isDisabled(el)) states.push('disabled');
    if ((el as HTMLInputElement).required === true || el.getAttribute('aria-required') === 'true') {
      states.push('required');
    }
    const checked =
      el.getAttribute('aria-checked') ??
      ((el as HTMLInputElement).checked === true ? 'true' : null);
    if (checked === 'true') states.push('checked');
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) states.push(expanded === 'true' ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-selected') === 'true') states.push('selected');
    if (el.getAttribute('aria-invalid') === 'true') states.push('invalid');
    const role = roleOf(el);
    if (el.hasAttribute('aria-live') || role === 'status' || role === 'alert') states.push('live');
    return states.length > 0 ? ' [' + states.join(', ') + ']' : '';
  }

  /**
   * Flatten the page into `role "name" [state]` lines, one per node, two spaces
   * per level. Nodes with no name, no landmark role and nothing under them are
   * dropped, which is what keeps a real page inside the budget.
   */
  function buildOutline(
    root: Element,
    maxNodes: number
  ): { lines: OutlineLine[]; capped: boolean } {
    const lines: OutlineLine[] = [];
    let capped = false;
    function walk(el: Element, depth: number): boolean {
      // A line is never shorter than one character plus its newline, so a budget
      // of N characters can never render more than N lines. Past that, every
      // node walked is work whose output is guaranteed to be thrown away — and
      // on a 10 000-row table that work is the whole round trip.
      if (lines.length >= maxNodes) {
        capped = true;
        return false;
      }
      if (SKIPPED_TAGS.has(el.tagName.toLowerCase())) return false;
      // SELF only: this walk descends from the root, so every ancestor was
      // already asked and a hidden one pruned the whole subtree before us.
      if (!isSelfVisible(el)) return false;
      const role = roleOf(el);
      const name = role ? nameOfWithRole(el, role) : '';
      const keep = Boolean(role) && (Boolean(name) || LANDMARK_ROLES.has(role));
      const at = lines.length;
      if (keep) {
        let text = role;
        if (name) text += ' "' + name + '"';
        const level = /^h[1-6]$/.test(el.tagName.toLowerCase())
          ? ' level=' + el.tagName.slice(1)
          : '';
        lines.push({ depth, text: text + level + statesOf(el) });
      }
      let anyChild = false;
      for (const child of Array.from(el.children)) {
        if (walk(child, keep ? depth + 1 : depth)) anyChild = true;
      }
      // A node kept only for its landmark role that turned out to have nothing
      // under it and no name is noise; drop it again.
      if (keep && !name && !anyChild && !LANDMARK_ROLES.has(role)) {
        lines.splice(at, 1);
        return false;
      }
      return keep || anyChild;
    }
    walk(root, 1);
    return { lines, capped };
  }

  /**
   * Render an outline inside a character budget, losing leaves before structure.
   *
   * Over budget, the DEEPEST lines go first, from the end — so what survives is
   * the shape of the page rather than its first few branches in full.
   */
  function renderOutline(root: Element, maxChars: number): { outline: string; truncated: boolean } {
    const header = 'document "' + trim(document.title, 512) + '"';
    const built = buildOutline(root, maxChars);
    const cut = truncate(header, built.lines, maxChars);
    // A walk stopped at its node ceiling lost lines too, whatever the budget
    // then did with the rest.
    return { outline: cut.outline, truncated: cut.truncated || built.capped };
  }

  /** Set a field's value the way a person typing into it would. */
  function setValue(el: Element, value: string): void {
    const proto = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else (el as HTMLInputElement).value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Dispatch one key, chord and all, at whatever has focus.
   *
   * Reports whether the page CANCELLED the keydown, because that is how a page
   * opts out of the browser's implicit form submission: a handler that calls
   * `preventDefault()` on Enter is saying "I am handling this, do not submit".
   * Ignoring the answer and submitting anyway is how one Enter becomes two
   * signups.
   */
  function pressKey(key: string): { key: string; cancelled: boolean } {
    const parts = key.split('+');
    const main = parts[parts.length - 1];
    const modifiers = parts.slice(0, -1).map((one) => one.toLowerCase());
    const init: KeyboardEventInit & { bubbles: boolean; cancelable: boolean } = {
      key: main,
      bubbles: true,
      cancelable: true,
      ctrlKey: modifiers.includes('control') || modifiers.includes('ctrl'),
      shiftKey: modifiers.includes('shift'),
      altKey: modifiers.includes('alt'),
      metaKey: modifiers.includes('meta') || modifiers.includes('cmd'),
    };
    const target = (document.activeElement as HTMLElement) || document.body;
    // `dispatchEvent` answers false when a handler called `preventDefault()`.
    const delivered = target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    return { key: main, cancelled: !delivered };
  }

  /** Input types that block implicit submission when there is more than one. */
  const IMPLICIT_SUBMIT_BLOCKERS = new Set([
    'text',
    'search',
    'url',
    'tel',
    'email',
    'password',
    'date',
    'month',
    'week',
    'time',
    'datetime-local',
    'number',
  ]);

  /**
   * Whether pressing Enter in this form would submit it, the way a browser
   * decides.
   *
   * The HTML implicit-submission rule, not an approximation of it: a form with a
   * submit button submits; a form without one submits only when exactly one
   * field blocks implicit submission. Two bare text inputs and no button is a
   * form Enter does nothing to — and calling `requestSubmit()` there would
   * submit something a person never could.
   */
  function wouldImplicitlySubmit(form: HTMLFormElement): boolean {
    const submitter = form.querySelector(
      'button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]'
    );
    if (submitter) return true;
    let blocking = 0;
    for (const field of Array.from(form.querySelectorAll('input'))) {
      const type = ((field as HTMLInputElement).getAttribute('type') || 'text').toLowerCase();
      if (IMPLICIT_SUBMIT_BLOCKERS.has(type)) blocking += 1;
    }
    return blocking === 1;
  }

  /**
   * The text a person can actually see on the page.
   *
   * `textContent` is the wrong answer and quietly so: it includes the source of
   * every `<script>` in the document, so a page whose own script mentions a
   * string would report that string as visible and a wait for it would return
   * instantly. `innerText` excludes both, but only where there is a layout
   * engine, so the walk below is what the fallback does instead.
   */
  function visibleText(root: Element): string {
    const withInner = root as HTMLElement;
    if (typeof withInner.innerText === 'string') return withInner.innerText;
    let text = '';
    for (const child of Array.from(root.childNodes)) {
      if (child.nodeType === 3) {
        text += child.nodeValue ?? '';
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      // Self only, for the reason the outline walk gives: this recursion has
      // already passed every ancestor.
      if (SKIPPED_TAGS.has(el.tagName.toLowerCase()) || !isSelfVisible(el)) continue;
      text += ' ' + visibleText(el);
    }
    return text;
  }

  /** Does the page show this text right now? */
  function pageHasText(wanted: string): boolean {
    const body = document.body;
    if (!body) return false;
    return visibleText(body).toLowerCase().includes(wanted.toLowerCase());
  }

  /**
   * Poll one condition until it holds or the deadline passes.
   *
   * `fetchIdle` is the one that needs its own memory: the condition is not "no
   * request is in flight" but "none has been in flight for 500 ms", so a burst
   * that starts one request as another finishes never reads as quiet.
   */
  function waitFor(
    command: DrivingCommand,
    done: (result: { ok: boolean; did?: string; error?: string; waitedMs: number }) => void
  ): void {
    const startedAt = Date.now();
    const timeoutMs = command.timeoutMs ?? 5_000;
    const gone = command.gone === true;
    let quietSince: number | null = ctx.inFlight() === 0 ? startedAt : null;
    const what = command.fetchIdle
      ? 'the page to stop fetching'
      : command.selector
        ? (gone ? 'the selector to disappear: ' : 'the selector: ') + trim(command.selector, 200)
        : (gone ? 'the text to disappear: "' : 'the text: "') + trim(command.text, 200) + '"';

    function satisfied(): boolean {
      if (command.fetchIdle) {
        if (ctx.inFlight() > 0) {
          quietSince = null;
          return false;
        }
        if (quietSince === null) quietSince = Date.now();
        return Date.now() - quietSince >= FETCH_QUIET_MS;
      }
      let present: boolean;
      if (command.selector) {
        try {
          present = document.querySelector(command.selector) !== null;
        } catch {
          present = false;
        }
      } else {
        present = pageHasText(command.text ?? '');
      }
      return gone ? !present : present;
    }

    function tick(): void {
      const waitedMs = Date.now() - startedAt;
      if (satisfied()) {
        done({
          ok: true,
          did: 'Waited for ' + what + ', which took ' + waitedMs + 'ms.',
          waitedMs,
        });
        return;
      }
      if (waitedMs >= timeoutMs) {
        done({
          ok: false,
          error: 'Waited ' + timeoutMs + 'ms for ' + what + ' and it never happened.',
          waitedMs,
        });
        return;
      }
      setTimeout(tick, POLL_MS);
    }
    tick();
  }

  /**
   * Answer one request, exactly once.
   *
   * The `pagehide` short-circuit is what keeps that true across a navigation: a
   * click that loads a new page would otherwise take the answer with it, and the
   * awaiting tool call would wait out its whole timeout for a click that
   * actually worked.
   */
  function answer(
    requestId: string,
    documentId: string | undefined,
    capture: boolean,
    lib: unknown
  ) {
    let sent = false;
    return function send(payload: Record<string, unknown>): void {
      if (sent) return;
      sent = true;
      const emit = (dataUrl: string | undefined): void => {
        ctx.post({
          __dorkosDevtools: 'act-result',
          requestId,
          documentId,
          page: pageSummary(),
          ...(dataUrl ? { dataUrl } : {}),
          ...payload,
        });
      };
      if (!capture) {
        emit(undefined);
        return;
      }
      // A frame is a nice-to-have on an answer the tool is waiting for, so it
      // may never delay or replace it: a page that cannot be rasterized, or is
      // on its way out, answers WITHOUT a picture rather than not at all. Three
      // races settle to the same single `emit`.
      let framed = false;
      const once = (dataUrl: string | undefined): void => {
        if (framed) return;
        framed = true;
        emit(dataUrl);
      };
      const onHide = (): void => once(undefined);
      window.addEventListener('pagehide', onHide);
      setTimeout(() => once(undefined), CAPTURE_BUDGET_MS);
      ctx.rasterize(lib).then(
        (dataUrl) => {
          window.removeEventListener('pagehide', onHide);
          once(dataUrl);
        },
        () => {
          window.removeEventListener('pagehide', onHide);
          once(undefined);
        }
      );
    };
  }

  return function handle(request: DrivingRequest): void {
    const send = answer(
      request.requestId,
      request.documentId,
      request.capture === true,
      request.lib
    );
    try {
      const command = request.command;
      // Anything that can move the page reports where the page ended up, and
      // reports it early if the page is on its way out.
      const settleThen = (payload: Record<string, unknown>): void => {
        const onHide = (): void => send(payload);
        window.addEventListener('pagehide', onHide);
        setTimeout(() => {
          window.removeEventListener('pagehide', onHide);
          send(payload);
        }, SETTLE_MS);
      };

      if (command.action === 'read_page') {
        let root: Element | null = document.body || document.documentElement;
        if (command.selector) {
          try {
            root = document.querySelector(command.selector);
          } catch {
            root = null;
          }
          if (!root) {
            send({
              ok: false,
              error:
                'Nothing on the page matched the selector ' +
                trim(command.selector, 200) +
                ', so there was no part of it to read.',
            });
            return;
          }
        }
        const { outline, truncated } = renderOutline(root!, command.maxChars ?? 32_768);
        send({ ok: true, outline, truncated, did: 'Read the page outline.' });
        return;
      }

      if (command.action === 'wait_for') {
        waitFor(command, (result) => send(result as unknown as Record<string, unknown>));
        return;
      }

      if (command.action === 'press') {
        const pressed = pressKey(command.key ?? 'Enter');
        const named = command.key ?? pressed.key;
        settleThen({
          ok: true,
          did: pressed.cancelled
            ? 'Pressed ' + named + '; the page handled it itself.'
            : 'Pressed ' + named + '.',
        });
        return;
      }

      if (command.action === 'scroll') {
        if (command.target) {
          const resolved = resolveTarget(command.target);
          if (!resolved.ok) {
            send({ ok: false, matched: resolved.matched, error: resolved.error });
            return;
          }
          const el = resolved.el as HTMLElement;
          if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
          send({
            ok: true,
            matched: resolved.matched,
            did: 'Scrolled to ' + describe(el) + '.',
          });
          return;
        }
        if (command.to) {
          const height = document.documentElement ? document.documentElement.scrollHeight : 0;
          window.scrollTo(0, command.to === 'top' ? 0 : height);
          send({ ok: true, did: 'Scrolled to the ' + command.to + ' of the page.' });
          return;
        }
        const by = command.by ?? 0;
        window.scrollBy(0, by);
        send({
          ok: true,
          did: 'Scrolled ' + Math.abs(by) + 'px ' + (by < 0 ? 'up' : 'down') + '.',
        });
        return;
      }

      if (command.action === 'click') {
        const resolved = resolveTarget(command.target ?? {});
        if (!resolved.ok) {
          send({ ok: false, matched: resolved.matched, error: resolved.error });
          return;
        }
        const el = resolved.el as HTMLElement;
        if (isDisabled(el)) {
          send({
            ok: false,
            matched: resolved.matched,
            error:
              'That matched a <' +
              el.tagName.toLowerCase() +
              '> that is disabled, so the click would do nothing.',
          });
          return;
        }
        const described = describe(el);
        if (typeof el.focus === 'function') el.focus();
        el.click();
        settleThen({ ok: true, matched: resolved.matched, did: 'Clicked ' + described + '.' });
        return;
      }

      if (command.action === 'type') {
        let el: Element | null = null;
        let matched = 1;
        if (command.target) {
          const resolved = resolveTarget(command.target);
          if (!resolved.ok) {
            send({ ok: false, matched: resolved.matched, error: resolved.error });
            return;
          }
          el = resolved.el;
          matched = resolved.matched;
        } else {
          el = document.activeElement;
          if (!el || el === document.body) {
            send({
              ok: false,
              error:
                'Nothing on the page has focus, so there was no field to type into. Name the ' +
                'field with a role and name, some visible text, or a CSS selector.',
            });
            return;
          }
        }
        const editable = el as HTMLInputElement & { isContentEditable?: boolean };
        const tag = el.tagName.toLowerCase();
        const typable =
          tag === 'input' || tag === 'textarea' || editable.isContentEditable === true;
        if (!typable) {
          send({
            ok: false,
            matched,
            error:
              'That matched a <' +
              tag +
              '>, which is not something you can type into. Name the field itself.',
          });
          return;
        }
        if (isDisabled(el)) {
          send({
            ok: false,
            matched,
            error:
              'That matched a <' + tag + '> that is disabled, so nothing could be typed into it.',
          });
          return;
        }
        if (typeof (el as HTMLElement).focus === 'function') (el as HTMLElement).focus();
        const text = command.text ?? '';
        if (editable.isContentEditable === true && tag !== 'input' && tag !== 'textarea') {
          (el as HTMLElement).textContent = command.clear ? text : (el.textContent || '') + text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          setValue(el, command.clear ? text : (editable.value || '') + text);
        }
        let did = 'Typed "' + trim(text, 200) + '" into ' + describe(el) + '.';
        if (command.submit) {
          const pressed = pressKey('Enter');
          const form = (el as HTMLInputElement).form;
          // Submit ONLY what a person pressing Enter would have submitted. A
          // page that cancels the keydown is opting out of implicit submission,
          // and a form the browser would not implicitly submit is not one to
          // submit on its behalf. Calling `requestSubmit()` past either of those
          // is a second signup the person never asked for.
          const canSubmit =
            !pressed.cancelled &&
            form !== null &&
            form !== undefined &&
            typeof form.requestSubmit === 'function' &&
            wouldImplicitlySubmit(form);
          if (canSubmit) {
            form.requestSubmit();
            did += ' Then pressed Enter, which submitted the form.';
          } else if (pressed.cancelled) {
            did += ' Then pressed Enter; the page handled it itself.';
          } else {
            did +=
              ' Then pressed Enter. It submitted nothing: the page has no form here that ' +
              'Enter would submit.';
          }
          settleThen({ ok: true, matched, did });
          return;
        }
        send({ ok: true, matched, did });
        return;
      }

      send({ ok: false, error: 'That is not something this page knows how to do.' });
    } catch (err) {
      send({
        ok: false,
        error: trim(err instanceof Error ? err.message : String(err), 500) || 'The page threw.',
      });
    }
  };
}
