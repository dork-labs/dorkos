// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LocalBrowserHandoff, LocalBrowserPersonState } from '@dorkos/shared/local-browser';
import { askedAgo, BrowserStatusPill, browserPillCopy } from '../ui/BrowserStatusPill';
import {
  BROWSER_PILL_KINDS,
  browserPillState,
  chromeTakesOver,
  type BrowserPillState,
} from '../model/browser-pill-state';

/** Phone or not, as `useIsMobile` reads it. */
let phone = false;
beforeEach(() => {
  phone = false;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: phone,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});
afterEach(() => vi.restoreAllMocks());

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const handoff: LocalBrowserHandoff = {
  id: 'h1',
  sessionId: 'chat-one',
  agentName: 'Atlas',
  agentId: null,
  agentFolder: null,
  profileId: null,
  reason: 'password',
  site: 'northwind.example',
  askedAt: '2026-11-15T11:58:00.000Z',
  outcome: null,
};
const base: LocalBrowserPersonState = {
  connectionId: 'c1',
  sessionId: 'chat-one',
  mode: 'embedded',
  status: 'connected',
  paused: false,
  tabs: [{ id: 't1', url: 'https://northwind.example/pricing', title: 'Pricing' }],
  selectedTabId: 't1',
  revision: 1,
  preparation: null,
  handoff: null,
  signIn: null,
  takenOver: false,
};

/** One example of every state, P1 to P9, in spec order. */
const EVERY_STATE: Record<BrowserPillState['kind'], BrowserPillState> = {
  driving: { kind: 'driving' },
  paused: { kind: 'paused' },
  'your-turn': {
    kind: 'your-turn',
    site: 'northwind.example',
    reason: 'password',
    handoffId: 'h1',
    askedAt: handoff.askedAt,
  },
  you: { kind: 'you' },
  'handed-back': { kind: 'handed-back' },
  'only-you': { kind: 'only-you' },
  elsewhere: { kind: 'elsewhere' },
  'paused-sign-in': { kind: 'paused-sign-in', sessionId: 'chat-two' },
  waiting: { kind: 'waiting' },
};

function pill(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-slot="browser-status-pill"]')!;
}

describe('browserPillState', () => {
  it.each([
    ['P1 the agent drives', base, false, 'driving'],
    ['P2 paused', { ...base, paused: true }, false, 'paused'],
    ['P3 this chat’s agent asked', { ...base, paused: true, handoff }, false, 'your-turn'],
    ['P4 the person took it', { ...base, paused: true, takenOver: true }, false, 'you'],
    ['P5 just handed back', base, true, 'handed-back'],
    ['P6 no chat shares it', { ...base, sessionId: null }, false, 'only-you'],
    ['P7 another chat has it', { ...base, sessionId: 'chat-two' }, false, 'elsewhere'],
    [
      'P8 another chat’s agent waits on a sign-in',
      { ...base, sessionId: 'chat-two', handoff: { ...handoff, sessionId: 'chat-two' } },
      false,
      'paused-sign-in',
    ],
    ['P9 no page yet', { ...base, selectedTabId: null }, false, 'waiting'],
    [
      'an ended handoff is no Your turn',
      { ...base, handoff: { ...handoff, outcome: 'handed-back' as const } },
      false,
      'driving',
    ],
    ['taken beats handed back', { ...base, takenOver: true }, true, 'you'],
  ] as const)('%s', (_case, state, handedBack, kind) => {
    expect(browserPillState(state, 'chat-one', handedBack).kind).toBe(kind);
  });

  it('covers all nine states', () => {
    expect(BROWSER_PILL_KINDS).toHaveLength(9);
    expect(Object.keys(EVERY_STATE)).toEqual([...BROWSER_PILL_KINDS]);
  });

  it('takes P3’s site from the handoff record only, never the page title or address', () => {
    // A lookalike page: its title and address say "bank", the agent calls itself a bank.
    const state: LocalBrowserPersonState = {
      ...base,
      paused: true,
      tabs: [
        {
          id: 't1',
          url: 'https://your-bank.example.attacker.example/login',
          title: 'Sign in to your-bank.example',
        },
      ],
      handoff: { ...handoff, agentName: 'your-bank.example', site: 'attacker.example' },
    };
    const derived = browserPillState(state, 'chat-one');
    expect(derived).toMatchObject({ kind: 'your-turn', site: 'attacker.example' });
  });

  it('lets the chrome take the page only from an agent that has it', () => {
    const takes = BROWSER_PILL_KINDS.filter((kind) => chromeTakesOver(EVERY_STATE[kind]));
    expect(takes).toEqual(['driving', 'paused', 'handed-back']);
  });
});

describe('askedAgo', () => {
  it.each([
    ['2026-11-15T11:59:40.000Z', 'Asked just now.'],
    ['2026-11-15T11:59:00.000Z', 'Asked 1 minute ago.'],
    ['2026-11-15T11:58:00.000Z', 'Asked 2 minutes ago.'],
    ['2026-11-15T10:00:00.000Z', 'Asked 2 hours ago.'],
    // A clock a little ahead never says "in the future".
    ['2026-11-15T12:01:00.000Z', 'Asked just now.'],
  ])('%s reads %s', (askedAt, words) => {
    expect(askedAgo(askedAt, NOW)).toBe(words);
  });
});

describe('BrowserStatusPill', () => {
  // Spec §4: icon label, popover sentence, buttons (primary first), status words.
  it.each([
    ['driving', 'Atlas', 'Atlas is using this page.', ['Take over', 'Pause agent'], 'Connected'],
    [
      'paused',
      'Paused',
      'Atlas won’t start anything new. It can still see this page.',
      ['Resume agent', 'Take over'],
      'Agent paused',
    ],
    [
      'your-turn',
      'Your turn',
      'Atlas needs you to sign in to northwind.example.',
      ['Hand back to Atlas', 'See the request'],
      'Waiting for you',
    ],
    [
      'you',
      'You',
      'Atlas can’t see or use this page until you hand it back.',
      ['Hand back to Atlas'],
      'You have the page. Atlas can’t see it until you hand it back.',
    ],
    [
      'handed-back',
      'Handed back',
      'Atlas is using this page.',
      ['Take over', 'Pause agent'],
      'Handed back to Atlas.',
    ],
    [
      'only-you',
      'Only you',
      'Only you can use this page. Open it from an agent chat to share it.',
      [],
      'Only you can use this page.',
    ],
    [
      'elsewhere',
      'In another chat',
      'This page is in another chat.',
      [],
      'This page is in another chat.',
    ],
    [
      'paused-sign-in',
      'Paused',
      'Paused while you sign in for another chat. Atlas can still read this page.',
      ['Show the sign-in'],
      'Agent paused',
    ],
    [
      'waiting',
      'Waiting',
      'Atlas hasn’t opened a page yet. It shows here when it does.',
      [],
      'Waiting for a page',
    ],
  ] as const)('%s: says %s', async (kind, label, sentence, buttons, status) => {
    const handlers = {
      onTakeOver: vi.fn(),
      onPause: vi.fn(),
      onResume: vi.fn(),
      onHandBack: vi.fn(),
      onSeeRequest: vi.fn(),
      onShowSignIn: vi.fn(),
    };
    render(
      <BrowserStatusPill state={EVERY_STATE[kind]} agentName="Atlas" now={NOW} {...handlers} />
    );
    // Named by its full sentence, and a dialog it opens.
    expect(pill()).toHaveAccessibleName(sentence);
    expect(pill()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(pill()).toHaveTextContent(label);
    expect(label.length).toBeLessThanOrEqual(15);
    expect(screen.getByRole('status')).toHaveTextContent(status);
    // Reserved width, so the address field never moves between states.
    expect(pill()).toHaveClass('w-32');
    fireEvent.click(pill());
    await screen.findByText(sentence, { selector: 'p' });
    const offered = screen
      .queryAllByRole('button')
      .filter((button) => button !== pill())
      .map((button) => button.textContent);
    expect(offered).toEqual(buttons);
  });

  it('runs a button’s action and closes the popover', async () => {
    const onTakeOver = vi.fn();
    render(
      <BrowserStatusPill state={{ kind: 'driving' }} agentName="Atlas" onTakeOver={onTakeOver} />
    );
    fireEvent.click(pill());
    fireEvent.click(await screen.findByRole('button', { name: 'Take over' }));
    expect(onTakeOver).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull());
  });

  it('holds every button while another browser action runs', async () => {
    render(
      <BrowserStatusPill state={{ kind: 'paused' }} agentName="Atlas" busy onResume={vi.fn()} />
    );
    fireEvent.click(pill());
    expect(await screen.findByRole('button', { name: 'Resume agent' })).toBeDisabled();
  });

  it('wears orange only for Your turn, and keeps its words below 480px', () => {
    for (const kind of BROWSER_PILL_KINDS) {
      const { unmount } = render(
        <BrowserStatusPill state={EVERY_STATE[kind]} agentName="Atlas" now={NOW} />
      );
      const orange = pill().className.includes('bg-brand');
      expect(orange).toBe(kind === 'your-turn');
      const word = pill().querySelector('span:last-child')!;
      expect(word.className.includes('@max-[479px]/browser-chrome:sr-only')).toBe(
        kind !== 'your-turn'
      );
      unmount();
    }
  });

  it('gives every state a tap area at least 44 × 44 on a phone, however small the chip', () => {
    // DOR-4420 spec §12: the drawn chip may be smaller; its hit area may not.
    // jsdom draws nothing, so this pins the classes that make the area:
    // 40 tall plus 2px above and below, and at least 44 wide, centred.
    for (const kind of BROWSER_PILL_KINDS) {
      const { unmount } = render(
        <BrowserStatusPill state={EVERY_STATE[kind]} agentName="Atlas" now={NOW} />
      );
      const classes = pill().classList;
      expect(classes.contains('max-md:h-10')).toBe(true);
      expect(classes.contains('max-md:after:-inset-y-0.5')).toBe(true);
      expect(classes.contains('max-md:after:inset-x-[min(0px,calc((100%_-_2.75rem)/2))]')).toBe(
        true
      );
      // The wider rule replaced the chip's own edge-to-edge one rather than fight it.
      expect(classes.contains('max-md:after:inset-x-0')).toBe(false);
      // The drawn chip stays snug below 480px, as before.
      expect(classes.contains('@max-[479px]/browser-chrome:w-auto')).toBe(kind !== 'your-turn');
      unmount();
    }
  });

  it('shows Your turn’s full words on a phone and never shrinks', () => {
    render(<BrowserStatusPill state={EVERY_STATE['your-turn']} agentName="Atlas" now={NOW} />);
    // As wide as its words on a phone; the desktop's reserved width stays.
    expect(pill()).toHaveClass('shrink-0', 'w-32', 'max-md:w-auto');
    const word = pill().querySelector('span:last-child')!;
    expect(word).toHaveTextContent('Your turn');
    // The words can't be squeezed into an ellipsis there.
    expect(word).toHaveClass('max-md:min-w-max');
    expect(word.className).not.toContain('sr-only');
  });

  it('shows a live dot only while the agent drives', () => {
    const { rerender } = render(
      <BrowserStatusPill state={{ kind: 'driving' }} agentName="Atlas" />
    );
    expect(document.querySelector('[data-slot="browser-status-pill-live"]')).not.toBeNull();
    rerender(<BrowserStatusPill state={{ kind: 'paused' }} agentName="Atlas" />);
    expect(document.querySelector('[data-slot="browser-status-pill-live"]')).toBeNull();
  });

  it('opens a real Radix popover, which the page-hiding rule sees over the page', async () => {
    render(
      <BrowserStatusPill state={{ kind: 'driving' }} agentName="Atlas" onTakeOver={vi.fn()} />
    );
    fireEvent.click(pill());
    await screen.findByRole('button', { name: 'Take over' });
    // `useNativeBrowserSurface` hides or freezes the native page under exactly this.
    expect(document.querySelector('[data-radix-popper-content-wrapper]')).not.toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('becomes a bottom sheet on a phone', async () => {
    phone = true;
    render(
      <BrowserStatusPill state={{ kind: 'driving' }} agentName="Atlas" onTakeOver={vi.fn()} />
    );
    fireEvent.click(pill());
    const sheet = await screen.findByRole('dialog');
    expect(sheet).toHaveAttribute('data-slot', 'drawer-content');
    expect(document.querySelector('[data-radix-popper-content-wrapper]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Take over' })).toBeInTheDocument();
  });

  it('titles the phone sheet on the body’s own left edge, P9 in full', async () => {
    phone = true;
    render(<BrowserStatusPill state={{ kind: 'waiting' }} agentName="Atlas" />);
    fireEvent.click(pill());
    const title = await screen.findByRole('heading', { name: 'Waiting for a page' });
    // The sheet's body already has its inset; the header adds none on top.
    expect(title.closest('[data-slot="drawer-header"]')).toHaveClass('px-0');
  });

  it('says "The agent" when the chat names none, and never invents a site', () => {
    const copy = browserPillCopy(EVERY_STATE['your-turn'], null, NOW);
    expect(copy.lines[0]).toBe('The agent needs you to sign in to northwind.example.');
    expect(browserPillCopy({ kind: 'driving' }, '  ', NOW).label).toBe('Agent');
  });

  it.each(['You', 'your turn', ' Paused ', 'Only you', 'Agent'])(
    'quotes an agent named %j, so it never passes for the pill’s own words',
    (name) => {
      const copy = browserPillCopy({ kind: 'driving' }, name, NOW);
      expect(copy.label).toBe(`“${name.trim()}”`);
      expect(copy.lines[0]).toBe(`“${name.trim()}” is using this page.`);
    }
  );

  it('quotes the agent in Hand back too, and leaves an ordinary name alone', async () => {
    render(<BrowserStatusPill state={{ kind: 'you' }} agentName="You" onHandBack={vi.fn()} />);
    expect(pill()).toHaveAccessibleName('“You” can’t see or use this page until you hand it back.');
    fireEvent.click(pill());
    expect(await screen.findByRole('button', { name: 'Hand back to “You”' })).toBeInTheDocument();
    expect(browserPillCopy({ kind: 'driving' }, 'Youssef', NOW).label).toBe('Youssef');
  });

  it('names a wall, not a sign-in, when the agent asked for another step', () => {
    const wall = { ...(EVERY_STATE['your-turn'] as object), reason: 'wall' } as BrowserPillState;
    expect(browserPillCopy(wall, 'Atlas', NOW).lines[0]).toBe(
      'Atlas needs you to finish a step on northwind.example.'
    );
  });

  // Security Must (DOR-4428): the host is the real one, the agent's words never stand in for it.
  it('names the real host in P3 even when every agent-written word says another site', () => {
    const state = browserPillState(
      {
        ...base,
        paused: true,
        tabs: [
          { id: 't1', url: 'https://attacker.example/', title: 'Sign in to your-bank.example' },
        ],
        handoff: { ...handoff, agentName: 'your-bank.example', site: 'attacker.example' },
      },
      'chat-one'
    );
    render(<BrowserStatusPill state={state} agentName="your-bank.example" now={NOW} />);
    expect(pill()).toHaveAccessibleName(
      'your-bank.example needs you to sign in to attacker.example.'
    );
    // The page's title, which the page itself wrote, appears nowhere.
    expect(document.body.textContent).not.toContain('Sign in to your-bank.example');
  });
});
