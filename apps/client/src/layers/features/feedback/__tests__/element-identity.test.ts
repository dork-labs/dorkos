// @vitest-environment jsdom
//
// Naming the element a person pointed at. jsdom is the right host for this one:
// the whole module reads attributes and runs `querySelectorAll`, and jsdom has a
// real DOM and a real selector engine. Nothing here depends on layout, which is
// the part jsdom cannot answer.
//
// jsdom limit worth naming: jsdom's `CSS.escape` exists, so the hand-rolled
// fallback beside it is not exercised here. It is there for a host that has no
// `CSS` global at all, and its job is only to keep a missing global from taking
// the whole identity down — a case a test would have to fabricate to see.
import { describe, it, expect, afterEach } from 'vitest';
import { MAX_FEEDBACK_ELEMENT_NAME_LEN } from '@dorkos/shared/telemetry-events';
import {
  buildSelector,
  describeElement,
  accessibleLabel,
  humanizeName,
  nameElement,
  MAX_SELECTOR_LEN,
} from '../lib/element-identity';

/** Mount markup under a `#root`, the way the app itself is mounted. */
function mount(html: string): HTMLElement {
  document.body.innerHTML = `<div id="root">${html}</div>`;
  const root = document.getElementById('root');
  if (!root) throw new Error('the app root must exist');
  return root;
}

/** The one element a query is expected to find. */
function find(selector: string): Element {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`nothing matched ${selector}`);
  return element;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('buildSelector — the shortest thing that still points at one element', () => {
  it('uses an id on its own when the id is unique', () => {
    mount('<div><button id="send-feedback">Send</button></div>');

    expect(buildSelector(find('#send-feedback'))).toBe('#send-feedback');
  });

  it('uses a test id on its own, which is the name the codebase already uses', () => {
    mount('<div><span><button data-testid="composer-send">Send</button></span></div>');

    expect(buildSelector(find('[data-testid="composer-send"]'))).toBe(
      '[data-testid="composer-send"]'
    );
  });

  it('falls through a duplicated test id rather than naming three elements at once', () => {
    // A testid is written to be stable, not to be unique — the same row
    // component rendered three times carries it three times. Returning it here
    // would hand back a "selector" that matches all three.
    mount(
      '<ul><li data-testid="row">a</li><li data-testid="row">b</li><li data-testid="row">c</li></ul>'
    );
    const second = document.querySelectorAll('[data-testid="row"]')[1];

    const selector = buildSelector(second);

    expect(document.querySelectorAll(selector)).toHaveLength(1);
    expect(document.querySelector(selector)).toBe(second);
  });

  it('names a component part by its slot when it has no id or test id', () => {
    mount('<div data-slot="sidebar"><button data-slot="sidebar-toggle">Toggle</button></div>');

    expect(buildSelector(find('[data-slot="sidebar-toggle"]'))).toBe(
      'button[data-slot="sidebar-toggle"]'
    );
  });

  it('falls back to a position among its siblings for an anonymous element', () => {
    mount('<section><p>one</p><p>two</p><p>three</p></section>');
    const third = document.querySelectorAll('p')[2];

    const selector = buildSelector(third);

    expect(selector).toContain(':nth-of-type(3)');
    expect(document.querySelector(selector)).toBe(third);
  });

  it('adds ancestors only until the path stops being ambiguous', () => {
    mount(`
      <div data-slot="panel-a"><ul><li><span>x</span></li></ul></div>
      <div data-slot="panel-b"><ul><li><span>x</span></li></ul></div>
    `);
    const target = document.querySelectorAll('[data-slot="panel-b"] span')[0];

    const selector = buildSelector(target);

    expect(document.querySelector(selector)).toBe(target);
    // The panel is what tells the two apart, so the walk stops there — it does
    // not keep climbing to `#root` once the path already matches one element.
    expect(selector).toContain('[data-slot="panel-b"]');
    expect(selector).not.toContain('#root');
  });

  it('never names the app root, even when that is what would tell two trees apart', () => {
    // `#root` is in every report and says nothing about the element. The walk
    // stops below it — which costs uniqueness in this contrived case, and is
    // still the right trade against prefixing a constant onto every selector a
    // person is asked to read.
    document.body.innerHTML =
      '<div id="root"><div><span>x</span></div></div><div><div><span>x</span></div></div>';
    const target = document.querySelector('#root span');
    if (!target) throw new Error('the target must exist');

    const selector = buildSelector(target);

    expect(selector).not.toContain('#root');
    expect(selector).toBe('div:nth-of-type(1) > span:nth-of-type(1)');
  });

  it('still names something when the click lands on the page itself', () => {
    // `elementFromPoint` answers `<body>` for a gap between panes. Walking on
    // from there would put `body` — and then `html` — into the report; there is
    // nowhere above it worth naming, so the tag is the whole answer.
    mount('<div><span>only</span></div>');

    expect(buildSelector(document.body)).toBe('body');
  });

  it('escapes a value that would otherwise break the selector it is put into', () => {
    mount('<button data-testid=\'say "hi"\'>Hi</button>');
    const target = find('button');

    const selector = buildSelector(target);

    // The quote inside the value must not close the attribute selector early —
    // an unescaped one makes a string that does not parse, and the whole
    // identity is lost to a thrown `SyntaxError`.
    expect(() => document.querySelectorAll(selector)).not.toThrow();
    expect(document.querySelector(selector)).toBe(target);
  });

  it('gives up on precision before it gives up on being readable', () => {
    // TWO identical deep chains, so nothing on the way up is ever unique and the
    // walk has to climb the whole way. The full path is real, and also
    // unreadable — a 900-character line of `div:nth-of-type(1) >` has stopped
    // identifying anything a person recognises and become noise in a bug report.
    const depth = 40;
    const chain =
      Array.from({ length: depth }, () => '<div>').join('') +
      '<span>deep</span>' +
      Array.from({ length: depth }, () => '</div>').join('');
    document.body.innerHTML = `<div id="root">${chain}${chain}</div>`;
    const target = document.querySelectorAll('#root span')[1];

    const selector = buildSelector(target);

    expect(selector.length).toBeLessThanOrEqual(MAX_SELECTOR_LEN);
    expect(selector.length).toBeGreaterThan(0);
  });
});

describe('buildSelector — the wire cap', () => {
  it('passes over a unique name that is too long to send', () => {
    const longId = 'x'.repeat(MAX_SELECTOR_LEN + 10);
    mount(`<section><button id="${longId}">go</button></section>`);

    const selector = buildSelector(find('button'));

    expect(selector.length).toBeLessThanOrEqual(MAX_SELECTOR_LEN);
    expect(selector).not.toContain(longId);
  });
});

describe('describeElement — the names a person can search for', () => {
  it('reads the nearest slot and test id, not only the element clicked', () => {
    // A click lands on the deepest thing under the pointer — the icon inside the
    // button. Reading only that element would report an anonymous `<svg>` and
    // throw away the name the button carries one hop up.
    mount(
      '<button data-slot="dialog-close" data-testid="close-feedback"><svg><path /></svg></button>'
    );

    const identity = describeElement(find('path'));

    expect(identity.slot).toBe('dialog-close');
    expect(identity.testId).toBe('close-feedback');
  });

  it('omits a name the element does not have rather than reporting an empty one', () => {
    mount('<div><span>plain</span></div>');

    const identity = describeElement(find('span'));

    expect(identity.slot).toBeUndefined();
    expect(identity.testId).toBeUndefined();
    expect(identity.selector).toBeTruthy();
  });
});

describe('describeElement — the wire cap on names', () => {
  it('leaves out a name too long to be one anybody wrote, rather than cutting it', () => {
    const longTestId = 'y'.repeat(MAX_FEEDBACK_ELEMENT_NAME_LEN + 1);
    mount(`<div data-slot="card" data-testid="${longTestId}"><span>x</span></div>`);

    const identity = describeElement(find('span'));

    expect(identity.testId).toBeUndefined();
    expect(identity.slot).toBe('card');
  });
});

describe('humanizeName — code names as words', () => {
  it('splits dashes, underscores and camel case, with a capital', () => {
    expect(humanizeName('message-list')).toBe('Message list');
    expect(humanizeName('chatInput_box')).toBe('Chat input box');
  });

  it('answers null when there are no words', () => {
    expect(humanizeName('--')).toBeNull();
  });
});

describe('accessibleLabel — the words on the thing', () => {
  it('names the control around an icon or inner text by its own text', () => {
    mount(
      '<div data-slot="app-shell"><button><svg></svg><span>Set up a daily run</span></button></div>'
    );
    expect(accessibleLabel(find('svg'))).toBe('Set up a daily run');
  });

  it('prefers aria-label to the visible text', () => {
    mount('<button aria-label="Close panel"><span>×</span></button>');
    expect(accessibleLabel(find('span'))).toBe('Close panel');
  });

  it('reads aria-labelledby', () => {
    mount('<span id="t">Rename agent</span><div role="button" aria-labelledby="t"><i></i></div>');
    expect(accessibleLabel(find('i'))).toBe('Rename agent');
  });

  it('cuts a long name at a word, near 40 characters', () => {
    mount('<button>Set up a daily run that summarises every conversation from yesterday</button>');
    const label = accessibleLabel(find('button'));
    expect(label?.endsWith('…')).toBe(true);
    expect(label?.length).toBeLessThanOrEqual(40);
    expect(label?.startsWith('Set up a daily run')).toBe(true);
  });

  it('never sends what was typed into a field, only its label', () => {
    mount('<label for="q">Search agents</label><input id="q" value="my private note" />');
    expect(accessibleLabel(find('input'))).toBe('Search agents');
    mount('<textarea>secret draft</textarea>');
    expect(accessibleLabel(find('textarea'))).toBeUndefined();
  });

  it('does not call a whole panel by its content', () => {
    mount('<section><p>First message</p><p>Second message</p></section>');
    expect(accessibleLabel(find('section'))).toBeUndefined();
  });

  it('uses a heading’s text outside any control', () => {
    mount('<div><h2><span>Schedules</span></h2></div>');
    expect(accessibleLabel(find('span'))).toBe('Schedules');
  });

  it('never names a draft in the composer by what was typed', () => {
    // How the Lexical composer draws a draft: the typed words are plain spans.
    mount(
      '<div contenteditable="true" aria-label="Message"><p><span data-lexical-text="true">my private draft</span></p></div>'
    );
    expect(accessibleLabel(find('[data-lexical-text]'))).toBe('Message');
    mount('<div role="textbox"><p><span>still private</span></p></div>');
    expect(accessibleLabel(find('span'))).toBeUndefined();
  });

  it('never names a line of a sent message by its words', () => {
    mount('<article><div><p>Deploy is done</p></div></article>');
    expect(accessibleLabel(find('p'))).toBeUndefined();
  });

  it('cuts between characters, never inside one', () => {
    // An emoji (a surrogate pair) straddling the 39th UTF-16 unit, where a
    // plain `slice` would keep only its first half.
    mount(`<button>${'a'.repeat(38)}😀😀😀 more words after it</button>`);
    const label = accessibleLabel(find('button')) ?? '';
    expect(label.endsWith('…')).toBe(true);
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(label)
    ).toBe(false);
  });
});

describe('nameElement — closest name first', () => {
  it('names a chip by its words, not by the shell around it (the "App shell" report)', () => {
    mount(
      '<div data-slot="app-shell"><button data-slot="button">Set up a daily run</button></div>'
    );
    expect(nameElement(find('button'))).toEqual({ text: 'Set up a daily run', onScreen: true });
  });

  it('falls back to its own test id, then its own slot', () => {
    mount(
      '<div data-slot="app-shell"><div data-testid="message-list" data-slot="scroll-area"></div></div>'
    );
    expect(nameElement(find('[data-testid="message-list"]'))).toEqual({
      text: 'Message list',
      onScreen: false,
    });
    mount('<div data-slot="app-shell"><div data-slot="scroll-area"></div></div>');
    expect(nameElement(find('[data-slot="scroll-area"]'))?.text).toBe('Scroll area');
  });

  it('then the nearest ancestor that has a name', () => {
    mount('<div data-testid="outer"><div data-slot="card"><div><i></i></div></div></div>');
    expect(nameElement(find('i'))?.text).toBe('Card');
  });

  it('answers null when nothing names it', () => {
    mount('<div><div><i></i></div></div>');
    expect(nameElement(find('i'))).toBeNull();
  });
});
