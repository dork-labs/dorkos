// @vitest-environment jsdom
/**
 * The dashboard hero composer, serialized — proof the wrap added a card and
 * nothing else.
 *
 * The baseline in `__baselines__/` was captured from the UNMIGRATED
 * `DashboardComposerSection` and committed before the wrap (`247ac851a`), when
 * `<Composer.Input>` sat directly under the `<section>` with no card chrome.
 * This file now renders the WRAPPED component against it (spec
 * `composer-parity`, task 2.5).
 *
 * Unlike chat's parity suite, the expected diff here is NOT empty — a card was
 * deliberately added. So the claim is made positively instead: the section still
 * has exactly two children, the second is a `div` carrying exactly Root's chrome
 * classes, and its serialized subtree is IDENTICAL to the node that used to sit
 * in that slot. Everything above and beside it is untouched.
 *
 * Asserted that way rather than by counting raw diff entries on purpose: the
 * differ walks children POSITIONALLY, so inserting a wrapper reports as a
 * cascade of differences at that index — a `tag` change plus everything under
 * it — not as a tidy "one node added". Counting entries would be reading the
 * differ's walk order, not the claim.
 *
 * The real `ComposerInput` renders here, unlike in `DashboardComposerSection.test.tsx`
 * next door, which stubs the composer barrel down to the callbacks it asserts.
 * A stub would make the baseline a record of the stub — and the whole claim
 * being made is about markup.
 *
 * The "Jump back in" popover is real here too, with real rows behind it (spec
 * `team-room-home` §D2.3). That is deliberate: a composer at rest must have
 * exactly the markup it had before that panel existed, and the only way to say
 * so is to let it mount and find it has added nothing.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport, createMockSession } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import {
  serializeDom,
  domBaselinePath,
  diffDom,
  formatDomDiff,
  type SerializedElement,
} from '@/test-helpers/dom-parity';
import { readFileSync } from 'node:fs';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

// The registered ABSOLUTE path, matching the sibling suite's fixture. Only the
// default-agent seam is replaced — the rest of the entity is real, because the
// popover reads the operator's muted rooms through it.
vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return {
    ...actual,
    useDefaultAgentSession: () => ({
      startSession: vi.fn(),
      defaultAgentDir: '/home/kai/.dork/agents/dorkbot',
      defaultAgentDisplayName: 'DorkBot',
      defaultAgentIdentity: {
        name: 'dorkbot',
        displayName: 'DorkBot',
        agentId: 'agent-ulid-1',
        runtime: 'claude-code',
      },
      isDefaultAgentResolved: true,
    }),
  };
});

import { DashboardComposerSection } from '../ui/DashboardComposerSection';

/** A cockpit with something to jump back into, so the panel could draw if it would. */
function transportWithThreads(): Transport {
  return createMockTransport({
    listRecentSessions: vi.fn().mockResolvedValue({
      sessions: [createMockSession({ id: 'sess-1', title: 'Refactor auth middleware' })],
      agentActivity: {},
      warnings: [],
    }),
  });
}

/** Render the section for real: providers add no markup of their own. */
function renderSection(transport: Transport = transportWithThreads()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return render(<DashboardComposerSection />, { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

/** Root's card chrome — the complete class set the added wrapper must carry. */
const ROOT_CHROME = ['bg-surface', 'relative', 'm-0', 'rounded-xl', 'border', 'p-2'];

/** The committed pre-wrap baseline, as the harness serialized it. */
function baseline(): SerializedElement {
  const path = domBaselinePath(import.meta.url, 'dashboard-composer-section');
  return JSON.parse(readFileSync(path, 'utf8')) as SerializedElement;
}

/** The `<section>` inside a serialized RTL container. */
function sectionOf(tree: SerializedElement): SerializedElement {
  const found = tree.children.find(
    (child): child is SerializedElement => child.kind === 'element' && child.tag === 'section'
  );
  if (!found) throw new Error('no <section> in the serialized tree');
  return found;
}

describe('DashboardComposerSection — the wrap added a card and nothing else', () => {
  it('adds exactly one element: a Root div around the untouched composer subtree', () => {
    const { container } = renderSection();

    // The three things the wrap must leave alone.
    expect(
      screen.getByRole('heading', { name: 'What are we building today?' })
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-label', 'Message DorkBot…');

    const before = sectionOf(baseline());
    const after = sectionOf(serializeDom(container));

    // The section itself is unchanged: same tag, same classes, same attributes,
    // same child COUNT. A wrap that also moved or added a sibling fails here.
    expect(after.tag).toBe(before.tag);
    expect([...after.classes].sort()).toEqual([...before.classes].sort());
    expect(after.attrs).toEqual(before.attrs);
    expect(after.children).toHaveLength(before.children.length);
    expect(before.children).toHaveLength(2);

    // Child 0 — the heading — is untouched, to the byte.
    expect(after.children[0]).toEqual(before.children[0]);

    // Child 1 was the composer subtree; it is now the Root div.
    const wrapper = after.children[1] as SerializedElement;
    const wrapped = before.children[1] as SerializedElement;
    expect(wrapper.kind).toBe('element');
    expect(wrapper.tag).toBe('div');
    expect([...wrapper.classes].sort()).toEqual([...ROOT_CHROME].sort());
    // Root mounts no dropzone here, and the one attribute it does carry is
    // inert: DOR-947 stamps `data-composer-card` on every composer card so
    // `useFeedKeyboardNav` can treat a composer as ONE destination and put
    // Ctrl+End in the text field rather than on whichever control the markup
    // happens to put first. No styling and no behaviour of its own.
    expect(wrapper.attrs).toEqual({ 'data-composer-card': '' });

    // And the thing it wraps is the OLD subtree, unchanged — this is the whole
    // claim. `diffDom` compares the two directly, so any drift inside the
    // composer reads out as a normal diff rather than an equality dump.
    expect(wrapper.children).toHaveLength(1);
    expect(formatDomDiff(diffDom(wrapped, wrapper.children[0]!))).toBe('');
  });

  it('has no dropzone: the dashboard passes no onAttach, so nothing mounts a file input', () => {
    // Recorded as a negative because the migration must NOT acquire one — the
    // capability matrix says the dashboard follows chat on attach, which means
    // it inherits the seam later, not that Root wires one now.
    const { container } = renderSection();

    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Attach file' })).toBeNull();
    expect(container.querySelector('[role="presentation"]')).toBeNull();
  });
});
