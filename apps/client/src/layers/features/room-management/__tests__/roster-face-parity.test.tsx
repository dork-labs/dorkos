// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AuthorRef, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { MemberList } from '@/layers/entities/room';
import { RoomMemberRow, type RoomMemberRowProps } from '../ui/RoomMemberRow';

/**
 * The two surfaces that draw the same roster, one file apart.
 *
 * `RoomMemberRow` is the member sheet's line; `MemberList` is the masthead's
 * stack of discs. They cannot share a component — `MemberList` is
 * `entities/room` and may not import `entities/agent` — so each hand-rolled the
 * same face ladder and then disagreed about the shape, the corner mark and the
 * colour. The same agent read as two different identities depending on which
 * half of the room you looked at.
 *
 * This file asserts the two agree. It is the acceptance test for the shared
 * resolver, and it fails against every version of this code where each surface
 * decided for itself.
 *
 * **What it deliberately cannot see:** every fixture here renders the row with
 * `visual: null`, so the sheet's fleet override is never exercised and the one
 * divergence that survives this change is out of frame — an agent whose
 * manifest colour reached the fleet but not its author record still paints one
 * colour in the sheet and another in the masthead, because only the sheet can
 * reach the fleet. Closing that is a separate design decision about whether an
 * entity component may accept a fleet-resolved face; it is tracked, and this
 * file will need a case of its own when it lands.
 */

/** jsdom has no `matchMedia`, and the row asks for one on every render. */
beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

afterEach(cleanup);

function member(
  author: Partial<AuthorRef> & Pick<AuthorRef, 'kind'>,
  origin: RoomRosterEntry['origin'] = 'local'
): RoomRosterEntry {
  return {
    roomId: 'room-1',
    authorId: 'author-ana',
    responseMode: 'mention-only',
    joinedAt: '2026-07-26T10:00:00.000Z',
    joinedSeq: 0,
    lastReadSeq: 0,
    author: { id: 'author-ana', displayName: 'Ana', handle: null, ...author },
    origin,
  };
}

/** One disc's four decisions, in a form the two surfaces can be compared on. */
interface Face {
  /** Round is the person shape, square the agent one. */
  shape: 'circle' | 'square';
  /**
   * The corner mark, identified by whatever it carries — `'none'` when the disc
   * wears none at all. A lucide glyph is known by its class; a platform logo
   * ships without one, so it is known by its own path data instead. Read this
   * way rather than as "is there an svg", which cannot tell a bot mark from
   * Telegram's.
   */
  badge: string;
  /** What the disc painted itself with — the whole declaration, tint or fill. */
  paint: string;
  /** The face itself: the emoji, or the letter drawn in place of one. */
  glyph: string;
  /**
   * The photo's URL, or `'none'` when the disc drew no `<img>` at all.
   *
   * A field of its own rather than folded into {@link Face.glyph}, because a
   * photo REPLACES the glyph: a surface that dropped the photo would fall back
   * to the emoji, and comparing glyphs alone would then be comparing two discs
   * that both say `🐙` while only one of them shows a face.
   */
  photo: string;
}

/**
 * What one disc decided to be.
 *
 * The radius CLASS cannot be compared across the two surfaces — the sheet draws
 * at `sm` and the masthead at `xs`, and the square radius steps up with the
 * diameter on purpose. What must match is the decision behind it, so this reads
 * the decision rather than the class: `rounded-full` is the person shape,
 * anything else is the agent one.
 */
function faceOf(root: HTMLElement): Face {
  const disc = root.querySelector<HTMLElement>(
    '[data-slot="identity-avatar"], [data-slot="room-member-avatar"]'
  );
  if (disc === null) throw new Error('no disc drawn');
  // Read inside the disc only: the row draws its own chevron and "…" beside it,
  // and neither may ever stand in for a badge.
  const mark = disc.querySelector('svg');
  return {
    shape: disc.className.includes('rounded-full') ? 'circle' : 'square',
    badge: mark === null ? 'none' : (mark.getAttribute('class') ?? mark.innerHTML),
    paint: disc.style.backgroundColor,
    // The FIRST child, not `disc.textContent`: the masthead's disc also carries
    // an `sr-only` name, and reading the whole subtree would compare a glyph on
    // one surface against a glyph plus a name on the other.
    glyph: disc.firstElementChild?.textContent ?? '',
    photo: disc.querySelector('img')?.getAttribute('src') ?? 'none',
  };
}

/** The member sheet's line, drawn for one member and read back. */
function rowFace(entry: RoomRosterEntry): Face {
  const props: RoomMemberRowProps = {
    member: entry,
    roomKind: 'channel',
    isReader: false,
    visual: null,
    presence: null,
    lastSpokeAt: null,
    expanded: false,
    onExpandedChange: vi.fn(),
    onRungChange: vi.fn(),
    onRungPreview: vi.fn(),
    savingRung: false,
    rungError: null,
    roomTitle: '#general',
    onRemoveRequested: vi.fn(),
    confirmingRemoval: false,
    onConfirmRemoval: vi.fn(),
    onCancelRemoval: vi.fn(),
    engagedWindow: null,
    dormantReasonId: null,
  };
  const { container } = render(<RoomMemberRow {...props} />);
  const face = faceOf(container);
  cleanup();
  return face;
}

/** The masthead's roster, drawn for the same member and read back. */
function listFace(entry: RoomRosterEntry): Face {
  const { container } = render(
    <MemberList members={[entry]} onClick={() => {}} label="Members of #general" />
  );
  const face = faceOf(container);
  cleanup();
  return face;
}

describe('the roster reads the same in the sheet and in the masthead', () => {
  it('draws an agent identically in both', () => {
    // The sharpest violation in the identity audit: the sheet badged an agent
    // with `Bot` and the masthead badged only external people, so the same
    // agent wore a mark on one surface and nothing on the other — and both drew
    // it round, which is the person shape.
    // Carries a cached face, so this case exercises the record rung of the
    // ladder on both surfaces — including the emoji, which is the one thing a
    // shape-and-badge comparison would otherwise never look at.
    const agent = member({ kind: 'agent', agentRef: 'ref-ana', emoji: '🐙', color: '#7c3aed' });
    const row = rowFace(agent);

    expect(row).toEqual(listFace(agent));
    expect(row.shape).toBe('square');
    expect(row.badge).toContain('lucide-bot');
    expect(row.glyph).toBe('🐙');
  });

  it('draws a person on this machine identically in both, and marks neither', () => {
    // Absence is the signal for a person. Red if either surface starts badging
    // one: a column of "person" marks puts the burden of proof on the humans.
    const person = member({ kind: 'human', id: 'author-dorian', displayName: 'Dorian' });
    const row = rowFace(person);

    expect(row).toEqual(listFace(person));
    expect(row.shape).toBe('circle');
    expect(row.badge).toBe('none');
  });

  it('draws a person bridged in from elsewhere identically in both', () => {
    // The other half of the asymmetry: the masthead drew Telegram's own mark
    // and the sheet drew nothing at all.
    const bridged = member(
      { kind: 'human', id: 'author-miguel', displayName: 'Miguel' },
      { platform: 'telegram' }
    );
    const row = rowFace(bridged);

    expect(row).toEqual(listFace(bridged));
    expect(row.shape).toBe('circle');
    expect(row.badge).not.toBe('none');
  });

  it('draws a member who has a photo identically in both', () => {
    // The fifth case, and the one the other four are blind to: every fixture
    // above leaves `imageUrl` unset, so deleting either surface's pass-through
    // left this whole file green. A photo REPLACES the glyph, so a surface that
    // dropped it falls back to the emoji — two discs that agree on `🐙` while
    // only one of them shows a face.
    const PHOTO = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const photographed = member({
      kind: 'human',
      id: 'author-dorian',
      displayName: 'Dorian',
      emoji: '🐙',
      color: '#0ea5e9',
      imageUrl: PHOTO,
    });
    const row = rowFace(photographed);

    expect(row).toEqual(listFace(photographed));
    expect(row.photo).toBe(PHOTO);
    // And the photo really did win: the emoji it would otherwise have drawn is
    // set on the fixture, so an equal-but-glyphed pair would mean neither
    // surface drew the photo at all.
    expect(row.glyph).toBe('');
  });

  it('gives a member neither surface could resolve the same colour in both', () => {
    // Nothing here has a stored face, so both fall to the last rung of the
    // ladder — which lands on the same colour only because there is one ladder
    // now. The sheet used to answer `currentColor` and the masthead a hashed
    // hue, so one member was two colours at once.
    const stranger = member({ kind: 'agent', id: 'author-nobody', displayName: 'Nobody' });
    const row = rowFace(stranger);

    expect(row.paint).not.toBe('');
    expect(row.paint).toBe(listFace(stranger).paint);
  });
});
