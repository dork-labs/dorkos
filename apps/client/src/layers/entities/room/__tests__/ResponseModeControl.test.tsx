// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RoomKind } from '@dorkos/shared/room-schemas';
import { ResponseModeControl } from '../ui/ResponseModeControl';
import type { ResponseRung } from '../lib/response-mode';

/**
 * Put the viewport below or above the 768px breakpoint for one test.
 *
 * `useIsMobile` asks `matchMedia`, which the shared setup answers "desktop" to.
 * Nothing here can measure anything — jsdom reports every element as 0 × 0 — so
 * the WIDTHS behind the adaptive split (segments ellipsising at 390px) are not
 * assertable in a unit test and are checked in a real browser instead. What is
 * assertable is that the two renderings exist and behave the same way.
 */
function viewport(width: 'phone' | 'desktop') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: width === 'phone',
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

const WINDOW = { engagedWindowMinutes: 10, engagedWindowPosts: 5 };

function renderControl(
  opts: {
    on?: 'phone' | 'desktop';
    roomKind?: RoomKind;
    value?: ResponseRung;
    /** Omit to test a caller that does not want previews at all. */
    withPreview?: boolean;
  } = {}
) {
  viewport(opts.on ?? 'desktop');
  const onChange = vi.fn<(rung: ResponseRung) => void>();
  const onPreview = vi.fn<(rung: ResponseRung | null) => void>();
  const utils = render(
    <ResponseModeControl
      memberName="Mio"
      roomKind={opts.roomKind ?? 'channel'}
      value={opts.value ?? 'mention'}
      onChange={onChange}
      onPreview={opts.withPreview === false ? undefined : onPreview}
      engagedWindow={WINDOW}
    />
  );
  return { ...utils, onChange, onPreview };
}

/** What the last preview report said, or `undefined` if nothing was reported. */
function lastPreview(onPreview: ReturnType<typeof vi.fn>): unknown {
  return onPreview.mock.calls.at(-1)?.[0];
}

/** The rungs, in the order they are rendered. */
function rungLabels(): string[] {
  return screen
    .getAllByRole('radio')
    .map((radio) => within(radio).getByText(/^(Silent|@only|Engaged|Everything)$/).textContent!);
}

afterEach(() => {
  cleanup();
  viewport('desktop');
});

describe('ResponseModeControl', () => {
  describe.each(['desktop', 'phone'] as const)('on %s', (on) => {
    it('is a radiogroup that says whose loudness it sets', () => {
      renderControl({ on });

      expect(screen.getByRole('radiogroup', { name: 'How loud is Mio here?' })).toBeInTheDocument();
    });

    it('shows the stored rung as the one selected', () => {
      renderControl({ on, value: 'engaged' });

      expect(screen.getByRole('radio', { checked: true })).toHaveAccessibleName('Engaged');
    });

    it('offers the same four rungs in a channel and in a direct message', () => {
      renderControl({ on, roomKind: 'channel' });
      expect(rungLabels()).toEqual(['Silent', '@only', 'Engaged', 'Everything']);

      cleanup();
      renderControl({ on, roomKind: 'dm' });
      // A direct message offered three for one commit, and `Engaged` was the
      // one missing — the only bounded setting there is, withheld from the
      // rooms where `Everything` is agent dominance by construction. Red if the
      // scale ever starts reading the room kind again.
      expect(rungLabels()).toEqual(['Silent', '@only', 'Engaged', 'Everything']);
    });

    it('shows a direct message’s stored engaged value on the engaged rung', () => {
      // It used to land on `@only` here, so a membership really holding
      // `engaged` was shown as something quieter — and the description under it
      // described that quieter thing. Red if the projection collapses again.
      renderControl({ on, roomKind: 'dm', value: 'engaged' });

      expect(screen.getByRole('radio', { checked: true })).toHaveAccessibleName('Engaged');
    });

    it('commits the rung that was clicked', () => {
      const { onChange } = renderControl({ on });

      fireEvent.click(screen.getByRole('radio', { name: 'Silent' }));

      expect(onChange).toHaveBeenCalledExactlyOnceWith('silent');
    });

    it('commits nothing for the rung that is already chosen', () => {
      // Every commit is a network write. Pressing the rung the control is
      // already showing as checked is not a change, and a write that stores
      // what is already stored is one the reader cannot see happen — which is
      // exactly how a DM's `engaged` was quietly narrowed to `mention-only`.
      //
      // The second click is the barrier: without it this would pass just as
      // well with `onChange` never wired up at all.
      const { onChange } = renderControl({ on, value: 'mention' });

      fireEvent.click(screen.getByRole('radio', { name: '@only' }));
      expect(onChange).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('radio', { name: 'Silent' }));
      expect(onChange).toHaveBeenCalledExactlyOnceWith('silent');
    });

    it('describes every rung by what it does, not only by what it is called', () => {
      // Red if the wiring is dropped: a screen reader would be left with a
      // one-word label, which is exactly the state five peer sentences left
      // everybody in.
      renderControl({ on, value: 'silent' });

      expect(screen.getByRole('radio', { checked: true })).toHaveAccessibleDescription(
        /Never speaks here/
      );
    });

    it('gives the keyboard one tab stop, on the rung the reader would land on', () => {
      renderControl({ on, value: 'engaged' });

      const stops = screen.getAllByRole('radio').filter((radio) => radio.tabIndex === 0);
      expect(stops).toHaveLength(1);
      expect(stops[0]).toHaveAccessibleName('Engaged');
    });

    it('moves the aim with the arrows without committing anything', () => {
      // The whole reason this is the manual-selection variant: every commit is
      // a network write, so arrowing across four rungs must not fire three.
      const { onChange } = renderControl({ on, value: 'silent' });
      const group = screen.getByRole('radiogroup');

      fireEvent.keyDown(group, { key: 'ArrowDown' });

      expect(onChange).not.toHaveBeenCalled();
      expect(screen.getByRole('radio', { checked: true })).toHaveAccessibleName('Silent');
    });

    it('commits whatever the arrows landed on once Enter is pressed', () => {
      const { onChange } = renderControl({ on, value: 'silent' });
      const group = screen.getByRole('radiogroup');

      fireEvent.keyDown(group, { key: 'ArrowDown' });
      // A real button turns Enter into a click, which is the commit — so what
      // this asserts is that the arrow moved DOM focus onto the next rung.
      fireEvent.click(document.activeElement!);

      expect(onChange).toHaveBeenCalledOnce();
      expect(onChange.mock.calls[0]![0]).not.toBe('silent');
    });

    it('jumps to the ends with Home and End', () => {
      renderControl({ on });
      const group = screen.getByRole('radiogroup');
      const labels = rungLabels();

      fireEvent.keyDown(group, { key: 'End' });
      expect(document.activeElement).toHaveAccessibleName(labels[labels.length - 1]!);

      fireEvent.keyDown(group, { key: 'Home' });
      expect(document.activeElement).toHaveAccessibleName(labels[0]!);
    });

    it('wraps rather than sticking at the far end', () => {
      renderControl({ on });
      const group = screen.getByRole('radiogroup');
      const labels = rungLabels();

      fireEvent.keyDown(group, { key: 'Home' });
      fireEvent.keyDown(group, { key: 'ArrowUp' });

      expect(document.activeElement).toHaveAccessibleName(labels[labels.length - 1]!);
    });
  });

  describe('the segmented control, above 768px', () => {
    it('runs quiet to loud, left to right', () => {
      // Position IS the meaning here — it is what five unrankable sentences
      // could never carry. Red if the order is ever sorted by anything else.
      renderControl({ on: 'desktop' });

      expect(rungLabels()).toEqual(['Silent', '@only', 'Engaged', 'Everything']);
    });

    it('writes one consequence, for the rung that is set', () => {
      renderControl({ on: 'desktop', value: 'engaged' });

      expect(
        screen.getByText(/keeps answering for 10 more minutes or 5 more messages/)
      ).toBeInTheDocument();
      expect(screen.queryByText('Never speaks here')).not.toBeInTheDocument();
    });

    it('rewrites the consequence as the keyboard moves, before anything is chosen', () => {
      // This is the preview the phone cannot have, and the reason arrows do not
      // select. Red if the explanation follows the value instead of the aim —
      // the reader would have to commit a rung to find out what it does.
      const { onChange } = renderControl({ on: 'desktop', value: 'silent' });

      fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'End' });

      expect(screen.getByText('Answers every message in this room.')).toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('slides the consequence back to what is set once the reader tabs away', () => {
      renderControl({ on: 'desktop', value: 'silent' });
      const group = screen.getByRole('radiogroup');

      fireEvent.keyDown(group, { key: 'End' });
      fireEvent.blur(group, { relatedTarget: document.body });

      expect(screen.getByText('Never speaks here')).toBeInTheDocument();
      expect(screen.queryByText('Answers every message in this room.')).not.toBeInTheDocument();
    });
  });

  describe('the rung list, below 768px', () => {
    it('runs quiet to loud, top to bottom — the same direction as the segments', () => {
      // One control must not have two directions. This list shipped reversed,
      // on the argument that the meter's bars grow upward; resizing a window
      // then physically turned the four options over as the layout crossed
      // 768px. Red if either rendering is ever ordered on its own again.
      renderControl({ on: 'phone' });

      expect(rungLabels()).toEqual(['Silent', '@only', 'Engaged', 'Everything']);
    });

    it('shows every consequence at once, which is what replaces the hover', () => {
      // There is no hover on touch, so the desktop preview cannot happen. Red
      // if the list ever prints only the selected rung's line: the phone would
      // then be a shrunken desktop with the teaching interaction removed and
      // nothing put in its place.
      renderControl({ on: 'phone', value: 'silent' });

      expect(screen.getByText('Never speaks here')).toBeInTheDocument();
      expect(screen.getByText('Answers only when you @mention it.')).toBeInTheDocument();
      expect(screen.getByText('Answers every message in this room.')).toBeInTheDocument();
      expect(
        screen.getByText(/keeps answering for 10 more minutes or 5 more messages/)
      ).toBeInTheDocument();
    });

    it('describes each rung by its own line rather than by a shared one', () => {
      renderControl({ on: 'phone', value: 'silent' });

      expect(screen.getByRole('radio', { name: 'Everything' })).toHaveAccessibleDescription(
        'Answers every message in this room.'
      );
    });
  });

  /**
   * What this control tells whatever is drawing the room's own consequence.
   *
   * Nothing here is about motion: jsdom runs no CSS transitions and measures
   * every element as 0 × 0, so how the meter gets from one reading to the other
   * is a browser question and is left to the browser suite. What IS settleable
   * is the contract — which rung is reported, when, and when the report is
   * withheld — and that is the whole of this block.
   */
  describe('what it reports as being contemplated', () => {
    it('reports the rung the pointer is over', () => {
      const { onPreview } = renderControl({ on: 'desktop', value: 'silent' });

      fireEvent.mouseEnter(screen.getByRole('radio', { name: 'Everything' }));

      expect(lastPreview(onPreview)).toBe('everything');
    });

    it('takes the report back when the pointer leaves', () => {
      const { onPreview } = renderControl({ on: 'desktop', value: 'silent' });
      const loudest = screen.getByRole('radio', { name: 'Everything' });

      fireEvent.mouseEnter(loudest);
      fireEvent.mouseLeave(loudest);

      expect(lastPreview(onPreview)).toBeNull();
    });

    it.each(['desktop', 'phone'] as const)(
      'reports the rung the arrow keys landed on, on %s',
      (on) => {
        // Keyboard parity is the point: the interaction that teaches the model
        // must not be one only a mouse can have. Red if the report is wired to
        // hover alone.
        const { onPreview } = renderControl({ on, value: 'silent' });

        fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'End' });

        expect(lastPreview(onPreview)).toBe('everything');
      }
    );

    it('withholds the report for the rung that is already stored', () => {
      // Pointing at the setting you already have is not a hypothetical, and a
      // surface told it was one would tint the status quo as a proposal. Red if
      // the comparison against the stored rung is dropped.
      const { onPreview } = renderControl({ on: 'desktop', value: 'silent' });

      fireEvent.mouseEnter(screen.getByRole('radio', { name: 'Silent' }));

      expect(lastPreview(onPreview)).toBeNull();
    });

    it('treats @only as a real proposal for a direct message set to engaged', () => {
      // The two used to be the same rung here, so this hover reported nothing:
      // the reader was pointing at what they already had. They are different
      // settings, and quieting an agent down to `@only` is a change the room's
      // line has to answer for. Red if `engaged` collapses onto `@only` again.
      const { onPreview } = renderControl({ on: 'desktop', roomKind: 'dm', value: 'engaged' });

      fireEvent.mouseEnter(screen.getByRole('radio', { name: '@only' }));

      expect(lastPreview(onPreview)).toBe('mention');
    });

    it('lets the arrow keys win over a pointer left resting on a rung', () => {
      // Both point, and the one that moved last is the one answering for the
      // reader. Red if hover is left in place across a key press: arrowing would
      // look dead for as long as the mouse happened to be over the control.
      const { onPreview } = renderControl({ on: 'desktop', value: 'silent' });

      fireEvent.mouseEnter(screen.getByRole('radio', { name: 'Everything' }));
      fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });

      expect(lastPreview(onPreview)).toBe('mention');
    });

    it('lets the pointer win after the arrows, which moved first', () => {
      // The other half of "last one to move wins". Red if the aim is given
      // precedence: a reader who arrowed and then reached for the mouse would
      // find hover dead until they tabbed out of the control entirely.
      const { onPreview } = renderControl({ on: 'desktop', value: 'silent' });

      fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'End' });
      fireEvent.mouseEnter(screen.getByRole('radio', { name: '@only' }));

      expect(lastPreview(onPreview)).toBe('mention');
    });

    it('takes the report back when the reader tabs out of the group', () => {
      const { onPreview } = renderControl({ on: 'desktop', value: 'silent' });
      const group = screen.getByRole('radiogroup');

      fireEvent.keyDown(group, { key: 'End' });
      fireEvent.blur(group, { relatedTarget: document.body });

      expect(lastPreview(onPreview)).toBeNull();
    });

    it('takes the report back when the scale is put away', () => {
      // Closing the row mid-hover would otherwise leave the room line stuck on
      // a hypothetical about a control that is no longer on screen. Red if the
      // unmount cleanup goes.
      const { onPreview, unmount } = renderControl({ on: 'desktop', value: 'silent' });

      fireEvent.mouseEnter(screen.getByRole('radio', { name: 'Everything' }));
      onPreview.mockClear();
      unmount();

      expect(onPreview).toHaveBeenCalledExactlyOnceWith(null);
    });

    it('reports nothing from a tap on the phone list, which has no pointer', () => {
      // A touch tap synthesises mouse events, and on the phone the tap IS the
      // commit — so a hover wired there would flash a preview of the rung being
      // chosen. The list prints all four consequences instead. Red if the
      // handlers are moved onto the shared radio props.
      const { onPreview } = renderControl({ on: 'phone', value: 'silent' });
      onPreview.mockClear();

      fireEvent.mouseEnter(screen.getByRole('radio', { name: 'Everything' }));

      expect(onPreview).not.toHaveBeenCalled();
    });

    it('rewrites the consequence for the rung the pointer is over', () => {
      // The room's line and this one must not preview different rungs. Red if
      // the explanation goes back to following the keyboard alone: hovering
      // would move the sentence at the top of the sheet and leave this one
      // describing something else.
      const { onChange } = renderControl({ on: 'desktop', value: 'silent' });

      fireEvent.mouseEnter(screen.getByRole('radio', { name: 'Everything' }));

      expect(screen.getByText('Answers every message in this room.')).toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('renders and previews normally for a caller that wants no report', () => {
      // The archived room passes nothing. Red if the control ever requires it.
      renderControl({ on: 'desktop', value: 'silent', withPreview: false });

      fireEvent.mouseEnter(screen.getByRole('radio', { name: 'Everything' }));

      expect(screen.getByText('Answers every message in this room.')).toBeInTheDocument();
    });
  });
});
