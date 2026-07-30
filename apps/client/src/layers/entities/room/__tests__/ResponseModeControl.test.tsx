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
  } = {}
) {
  viewport(opts.on ?? 'desktop');
  const onChange = vi.fn<(rung: ResponseRung) => void>();
  render(
    <ResponseModeControl
      memberName="Mio"
      roomKind={opts.roomKind ?? 'channel'}
      value={opts.value ?? 'mention'}
      onChange={onChange}
      engagedWindow={WINDOW}
    />
  );
  return { onChange };
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

    it('offers a channel four rungs and a direct message three', () => {
      renderControl({ on, roomKind: 'channel' });
      expect(screen.getAllByRole('radio')).toHaveLength(4);

      cleanup();
      renderControl({ on, roomKind: 'dm' });
      expect(screen.getAllByRole('radio')).toHaveLength(3);
    });

    it('renders a stored value this room never offers on the rung it behaves as', () => {
      // A direct message has no engaged rung — its window cannot open there —
      // and the API accepts `engaged` in every room, so a membership really can
      // hold one. Red if it blanks: a setting that renders empty is one nobody
      // can fix.
      renderControl({ on, roomKind: 'dm', value: 'engaged' });

      expect(screen.getByRole('radio', { checked: true })).toHaveAccessibleName('@only');
    });

    it('commits the rung that was clicked', () => {
      const { onChange } = renderControl({ on });

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
    it('runs loud to quiet, top to bottom', () => {
      // Louder is up on this axis, which is the direction the meter's own bars
      // grow. Red if the vertical list is ever silently reordered to match the
      // horizontal one, which would point loudness downwards.
      renderControl({ on: 'phone' });

      expect(rungLabels()).toEqual(['Everything', 'Engaged', '@only', 'Silent']);
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
});
