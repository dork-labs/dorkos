// @vitest-environment jsdom
//
// jsdom limits worth naming, because they bound what this file can claim.
// Nothing here settles how the picker LOOKS: the highlight box is positioned
// from a `getBoundingClientRect()` jsdom reports as 0x0, the crosshair cursor
// and the scrim are paint, and there is no hit-testing at all — jsdom does not
// implement `elementFromPoint`, so it is stubbed. What IS this component's own
// decision, and is checked here: that it asks the document what is underneath
// rather than answering "the overlay", that it turns its own hit-testing off to
// do so and puts it straight back, which events mean select and which mean
// cancel, and what it says while each is happening.
//
// The half only a browser can answer — that the picker really covers the app,
// that nothing underneath reacts, that a click on a live button does not
// activate it — is in
// `apps/e2e/tests/dev-playground/feedback-point-at-element.spec.ts`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PointAtElementOverlay } from '../ui/PointAtElementOverlay';

type OverlayProps = Parameters<typeof PointAtElementOverlay>[0];

beforeEach(() => {
  // jsdom implements no hit-testing at all, so `document.elementFromPoint` is
  // not merely wrong here — it does not exist, and a spy cannot replace a
  // property that is absent. Installed as a real one first, then stubbed per
  // test; a browser has this and every other DOM in the app relies on it.
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    writable: true,
    value: () => null,
  });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** The app underneath the picker, and the picker over it. */
function renderOverlay(overrides: Partial<OverlayProps> = {}) {
  const app = document.createElement('div');
  app.id = 'root';
  app.innerHTML = '<button data-slot="sidebar-toggle" data-testid="nav-toggle">Toggle</button>';
  document.body.append(app);
  const target = app.querySelector('button');
  if (!target) throw new Error('the app under the picker must have something to point at');

  const props: OverlayProps = {
    phase: 'picking',
    onSelect: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<PointAtElementOverlay {...props} />);
  const overlay = screen.getByRole('dialog');
  return { ...props, overlay, target };
}

/** Stand in for the browser's hit-testing, which jsdom does not have. */
function stubElementFromPoint(answer: Element | null): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(document, 'elementFromPoint').mockReturnValue(answer as Element);
}

describe('PointAtElementOverlay — what it says', () => {
  it('tells the person what to do and how to get out', () => {
    renderOverlay();

    expect(screen.getByText('Click the part that looks wrong. Esc to cancel.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('shows nothing at all once the picture is being taken', () => {
    renderOverlay({ phase: 'capturing' });

    // Not an omission. The capture fades every child of `<body>` to nothing so
    // the photograph is of the app alone, and this picker is one of those
    // children — a progress cue here is painted at zero for its whole life
    // (measured in a real Chromium; the browser spec samples the opacity), and a
    // cue anywhere it WOULD show is a cue in the photograph. So the hint bar,
    // the scrim and the Cancel button all stand down, and what bounds the wait
    // is `APP_CAPTURE_TIMEOUT_MS` rather than a spinner.
    expect(screen.queryByText(/click the part that looks wrong/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeEmptyDOMElement();
  });

  it('names itself for anyone who cannot see the crosshair', () => {
    renderOverlay();

    expect(screen.getByRole('dialog')).toHaveAccessibleName(
      'Point at the part of the app that looks wrong'
    );
  });
});

describe('PointAtElementOverlay — finding what is underneath', () => {
  it('turns its own hit-testing off for the lookup, and straight back on', () => {
    // Without this the browser answers "the overlay" for every point, and the
    // picker highlights itself. Restoring it matters just as much: an overlay
    // left transparent to the pointer stops swallowing clicks, and the next one
    // lands on the live app.
    const { overlay, target } = renderOverlay();
    let hitTestingDuringLookup: string | null = null;
    vi.spyOn(document, 'elementFromPoint').mockImplementation(() => {
      hitTestingDuringLookup = overlay.style.pointerEvents;
      return target;
    });

    fireEvent.pointerMove(overlay, { clientX: 40, clientY: 40 });

    expect(hitTestingDuringLookup).toBe('none');
    expect(overlay.style.pointerEvents).not.toBe('none');
  });

  it('puts its hit-testing back even when the lookup throws', () => {
    // The one case a `finally` buys and a plain restore does not. If the lookup
    // throws with hit-testing off, the picker stays transparent to the pointer
    // for good: every later click sails through to the live app it is supposed
    // to be covering, and the person is clicking on the thing they came to
    // report about.
    const { overlay } = renderOverlay();
    vi.spyOn(document, 'elementFromPoint').mockImplementation(() => {
      throw new Error('hit-testing blew up');
    });
    // React 19 hands a handler's throw to the error REPORTER rather than back
    // out of the dispatch, so `fireEvent` returns normally and the throw
    // surfaces as a window `error` event instead. Left alone it is an unhandled
    // error for the whole run, which Vitest rightly warns can mask real ones —
    // so this test owns the one it deliberately caused.
    const swallow = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener('error', swallow);
    try {
      fireEvent.pointerMove(overlay, { clientX: 40, clientY: 40 });
    } finally {
      window.removeEventListener('error', swallow);
    }

    // The damage is only ever visible in the style it left behind.
    expect(overlay.style.pointerEvents).not.toBe('none');
  });

  it('shows the name of the thing under the pointer', () => {
    const { overlay, target } = renderOverlay();
    stubElementFromPoint(target);

    fireEvent.pointerMove(overlay, { clientX: 40, clientY: 40 });

    // The test id first — it is the name the codebase itself uses for this part.
    expect(screen.getByText('nav-toggle')).toBeInTheDocument();
  });

  it('falls back to the slot, and then the tag, for an element with no test id', () => {
    const { overlay } = renderOverlay();
    const app = document.getElementById('root');
    if (!app) throw new Error('the app root must exist');
    const slotted = document.createElement('div');
    slotted.dataset.slot = 'composer';
    app.append(slotted);
    stubElementFromPoint(slotted);
    fireEvent.pointerMove(overlay, { clientX: 10, clientY: 10 });
    expect(screen.getByText('composer')).toBeInTheDocument();

    const anonymous = document.createElement('section');
    app.append(anonymous);
    stubElementFromPoint(anonymous);
    fireEvent.pointerMove(overlay, { clientX: 20, clientY: 20 });
    expect(screen.getByText('section')).toBeInTheDocument();
  });

  it('highlights nothing while the pointer is over its own controls', () => {
    // The bar sits over the app like everything else. Lighting up whatever
    // happens to be behind the Cancel button would be pointing at a lie.
    const { overlay, target } = renderOverlay();
    stubElementFromPoint(target);
    fireEvent.pointerMove(overlay, { clientX: 40, clientY: 40 });
    expect(screen.getByText('nav-toggle')).toBeInTheDocument();

    fireEvent.pointerMove(screen.getByRole('button', { name: 'Cancel' }), {
      clientX: 500,
      clientY: 900,
    });

    expect(screen.queryByText('nav-toggle')).not.toBeInTheDocument();
  });

  it('stops aiming once the pointer has left the window', () => {
    const { overlay, target } = renderOverlay();
    stubElementFromPoint(target);
    fireEvent.pointerMove(overlay, { clientX: 40, clientY: 40 });

    fireEvent.pointerLeave(overlay);

    expect(screen.queryByText('nav-toggle')).not.toBeInTheDocument();
  });

  it('does not aim at all once the picture is being taken', () => {
    const { overlay, target } = renderOverlay({ phase: 'capturing' });
    stubElementFromPoint(target);

    fireEvent.pointerMove(overlay, { clientX: 40, clientY: 40 });

    expect(screen.queryByText('nav-toggle')).not.toBeInTheDocument();
  });
});

describe('PointAtElementOverlay — committing', () => {
  it('hands back the element that was under the click', () => {
    const { overlay, target, onSelect } = renderOverlay();
    stubElementFromPoint(target);

    fireEvent.click(overlay, { clientX: 40, clientY: 40 });

    expect(onSelect).toHaveBeenCalledWith(target);
  });

  it('resolves the click fresh rather than trusting the last thing hovered', () => {
    // A click can arrive with no move before it, and a move can be stale by the
    // time the press lands. The point that was CLICKED is the one that counts.
    const { overlay, target, onSelect } = renderOverlay();
    const other = document.createElement('span');
    document.getElementById('root')?.append(other);
    stubElementFromPoint(other);
    fireEvent.pointerMove(overlay, { clientX: 40, clientY: 40 });
    stubElementFromPoint(target);

    fireEvent.click(overlay, { clientX: 900, clientY: 900 });

    expect(onSelect).toHaveBeenCalledWith(target);
  });

  it('takes no pick from a click on its own Cancel bar', () => {
    const { onSelect, onCancel, target } = renderOverlay();
    stubElementFromPoint(target);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('ignores a click once the picture is already being taken', () => {
    const { overlay, target, onSelect } = renderOverlay({ phase: 'capturing' });
    stubElementFromPoint(target);

    fireEvent.click(overlay, { clientX: 40, clientY: 40 });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('says nothing when the browser finds nothing under the pointer', () => {
    const { overlay, onSelect } = renderOverlay();
    stubElementFromPoint(null);

    fireEvent.click(overlay, { clientX: 40, clientY: 40 });

    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('PointAtElementOverlay — getting out', () => {
  it('cancels on Escape, from anywhere on the page', () => {
    const { onCancel } = renderOverlay();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels on a right-click, the other reflex for “not this”', () => {
    const { overlay, onCancel, onSelect } = renderOverlay();

    fireEvent.contextMenu(overlay, { clientX: 40, clientY: 40 });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('takes no key but Escape to mean cancel', () => {
    const { onCancel } = renderOverlay();

    fireEvent.keyDown(document.body, { key: 'a' });
    fireEvent.keyDown(document.body, { key: 'Enter' });

    expect(onCancel).not.toHaveBeenCalled();
  });

  it('will not be cancelled once the picture is being taken', () => {
    // The capture cannot be called off underneath (neither snapdom nor an IPC
    // round-trip is cancellable), so accepting a cancel here would only put the
    // dialog back on screen MID-PHOTOGRAPH — as a fresh `<body>` child the
    // capture's hide sweep never saw, which the desktop shell then photographs.
    // That is the exact failure the sweep exists to prevent.
    const { overlay, onCancel } = renderOverlay({ phase: 'capturing' });

    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.contextMenu(overlay, { clientX: 40, clientY: 40 });

    expect(onCancel).not.toHaveBeenCalled();
  });

  it('stops listening for Escape once it is gone', () => {
    // A key handler outliving its overlay would cancel a picker that is not
    // there, on a press meant for whatever has focus now.
    const { onCancel } = renderOverlay();
    cleanup();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('PointAtElementOverlay — holding the keyboard while aiming', () => {
  /**
   * A global shortcut listener in the position the app really uses.
   *
   * All three of them register on `document` in the bubble phase
   * (`use-global-palette.ts`, `use-message-search-shortcut.ts`,
   * `use-interactive-shortcuts.ts`), which is what makes them stoppable: a
   * `window` CAPTURE listener runs before propagation reaches `document` at all.
   *
   * Testing it in that position rather than an easier one matters, because the
   * easier one hides the real limit. A rival listener on `window` in the capture
   * phase, registered BEFORE the picker mounts, runs first and cannot be stopped
   * by anything the picker does — nothing in this app takes that position, and
   * anything that did would need to check for the picker itself.
   */
  function withAppShortcut(): { fired: ReturnType<typeof vi.fn>; stop: () => void } {
    const fired = vi.fn();
    document.addEventListener('keydown', fired);
    return { fired, stop: () => document.removeEventListener('keydown', fired) };
  }

  it('keeps every key from reaching the app it is covering', () => {
    // Without this the app underneath is fully keyboard-live under a picker
    // nobody can type into: Tab walks focus into a tree whose focus ring is
    // behind a scrim, Enter presses whatever it landed on, and every global
    // shortcut still fires — ⌘K opens the command palette UNDER the picker,
    // where it cannot be clicked and where this overlay eats its Escape.
    const { fired, stop } = withAppShortcut();
    try {
      renderOverlay();

      fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
      fireEvent.keyDown(document.body, { key: 'Tab' });
      fireEvent.keyDown(document.body, { key: 'Enter' });

      expect(fired).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('hands the keyboard back the moment the aiming ends', () => {
    // The app's own shortcuts have to work again during the capture and after
    // it — a listener that outlived the picker would swallow them for good.
    const { fired, stop } = withAppShortcut();
    try {
      renderOverlay({ phase: 'capturing' });

      fireEvent.keyDown(document.body, { key: 'k', metaKey: true });

      expect(fired).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it('takes focus on mount and gives it back on unmount', () => {
    // `aria-modal` is a claim, and a focus ring left sitting in the app behind
    // the picker contradicts it. Handing focus back matters just as much: the
    // person was writing a report, and cancelling must not drop their caret.
    const outside = document.createElement('input');
    document.body.append(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    const { overlay } = renderOverlay();
    expect(document.activeElement).toBe(overlay);

    cleanup();
    expect(document.activeElement).toBe(outside);
  });
});

describe('PointAtElementOverlay — the wheel and the scroll', () => {
  /** Make an element look like a real scrolling pane to jsdom, which has no layout. */
  function asScrollingPane(element: HTMLElement): { scrollBy: ReturnType<typeof vi.fn> } {
    element.style.overflowY = 'auto';
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 900 });
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 300 });
    const scrollBy = vi.fn();
    element.scrollBy = scrollBy as unknown as HTMLElement['scrollBy'];
    return { scrollBy };
  }

  it('scrolls the pane the pointer is over, which never sees the wheel itself', () => {
    // The picker covers the viewport, so a wheel is delivered to the picker —
    // and a fixed, non-scrolling box scrolls the DOCUMENT. In this app almost
    // nothing scrolls the document: the shell fills the window and content
    // scrolls inside panes. So without forwarding, everything below the fold of
    // every pane is unreachable the moment aiming starts.
    const { overlay, target } = renderOverlay();
    const pane = target.parentElement;
    if (!pane) throw new Error('the target must sit in a pane');
    const { scrollBy } = asScrollingPane(pane);
    stubElementFromPoint(target);

    fireEvent.wheel(overlay, { clientX: 40, clientY: 40, deltaY: 120 });

    // Found by walking UP from what is under the pointer: the thing being
    // pointed at is rarely the thing that scrolls.
    expect(scrollBy).toHaveBeenCalledWith({ left: 0, top: 120 });
  });

  it('leaves the wheel alone once the picture is being taken', () => {
    const { overlay, target } = renderOverlay({ phase: 'capturing' });
    const pane = target.parentElement;
    if (!pane) throw new Error('the target must sit in a pane');
    const { scrollBy } = asScrollingPane(pane);
    stubElementFromPoint(target);

    fireEvent.wheel(overlay, { clientX: 40, clientY: 40, deltaY: 120 });

    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('walks past a pane that cannot scroll', () => {
    // `overflow-y: auto` on a box whose content fits is not a scroller, and
    // scrolling it does nothing while the real pane above it stays put.
    const { overlay, target } = renderOverlay();
    const inner = target.parentElement;
    if (!inner?.parentElement) throw new Error('the target needs two ancestors');
    inner.style.overflowY = 'auto';
    Object.defineProperty(inner, 'scrollHeight', { configurable: true, value: 100 });
    Object.defineProperty(inner, 'clientHeight', { configurable: true, value: 100 });
    const innerScroll = vi.fn();
    inner.scrollBy = innerScroll as unknown as HTMLElement['scrollBy'];
    const { scrollBy } = asScrollingPane(inner.parentElement);
    stubElementFromPoint(target);

    fireEvent.wheel(overlay, { clientX: 40, clientY: 40, deltaY: 40 });

    expect(innerScroll).not.toHaveBeenCalled();
    expect(scrollBy).toHaveBeenCalledWith({ left: 0, top: 40 });
  });

  it('re-measures the highlight when something scrolls under it', () => {
    // The outline is drawn from a rect taken when the pointer last moved, and a
    // scroll moves the box without moving the pointer — so a stale outline sits
    // over whatever slid into its place.
    const { overlay, target } = renderOverlay();
    let top = 100;
    target.getBoundingClientRect = () => ({ left: 10, top, width: 200, height: 40 }) as DOMRect;
    stubElementFromPoint(target);
    fireEvent.pointerMove(overlay, { clientX: 40, clientY: 40 });

    const before = screen.getByText('nav-toggle').style.top;
    top = 20;
    fireEvent.scroll(document.getElementById('root') ?? document);

    expect(screen.getByText('nav-toggle').style.top).not.toBe(before);
  });
});
