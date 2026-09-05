import type { TeamMember } from '@dorkos/shared/team-schemas';
import type { IdentityStatus } from '@/layers/shared/ui';

/**
 * The whole live-state vocabulary an identity's corner dot can say, with the
 * words a showcase captions each one with.
 *
 * One list, imported by every showcase that draws the states, so the playground
 * cannot end up showing three different state systems for the fact this repo
 * spent a release drawing five different ways (DOR-1052).
 *
 * @module dev/mock-samples/identity
 */
export const IDENTITY_STATUSES: readonly { status: IdentityStatus; label: string }[] = [
  { status: 'idle', label: 'idle — no dot' },
  { status: 'working', label: 'working — pulses' },
  { status: 'needs-you', label: 'needs you — still' },
  { status: 'error', label: 'error — still' },
];

/**
 * One identity as the phase-1 identity surfaces need it. Deliberately not
 * `AuthorRef` — that's the wire shape a later slice resolves mentions and
 * avatars against; this is only what a presentational component reads.
 * `MentionPill` and `IdentityHoverCard` each pull a couple of these fields
 * under their own prop name (`label` vs. `displayName`), so one mock per
 * identity covers both showcases.
 */
export interface MockIdentity {
  kind: 'human' | 'agent' | 'system';
  displayName: string;
  handle?: string;
  color?: string;
  emoji?: string;
  /** A photo, when this identity has one — the face the disc draws over the emoji. */
  imageUrl?: string;
  origin?: 'local' | { platform: string };
  agent?: {
    runtime?: string;
    model?: string;
    working?: { forMs: number };
    /** Owner attribution (spec `identity-consistency` W1.6) — the hover card's fourth chip. */
    managedBy?: { displayName: string; handle: string | null };
  };
}

/**
 * A 16x16 PNG, inline, so the playground needs no network and no fixture file.
 * A gradient rather than a face: it has to read as "a photo is here" at 20px.
 */
const MOCK_PHOTO =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAACRElEQVR42g3Loa6FIAAA0PdhN9PcLBZnpLlZKM5IY7NQhGBgFJwbM8jYKCSDJDY2C8nEdzxPP38/UAB4a5Bb8EAQBxBGcGHgZ+AWcAqgd7AZID1Yb8ASoH+/qoDqravcVg+s4lCFsbpw5efKLdUpKr1Xm6mkr9a7Yqn6QlNA89ZNbpsHNnFowthcuPFz45bmFI3em8000jfr3bDUfKEroHvrLrfdA7s4dGHsLtz5uXNLd4pO791mOum79e5Y6r4AC4BvDXMLHwjjAMMILwz9DN0CTwH1DjcDpYfrDVmCX+gL6N+6z23/wD4OfRj7C/d+7t3Sn6LXe7+ZXvp+vXuW+i+gAtBbo9yiB6I4oDCiCyM/I7egUyC9o80g6dF6I5bQF6YCpreecjs9cIrDFMbpwpOfJ7dMp5j0Pm1mkn5a74ml6Qu4APzWOLf4gTgOOIz4wtjP2C34FFjveDNYerzemCX8BVIAeWuSW/JAEgcSRnJh4mfiFnIKoneyGSI9WW/CEvkCLYC+Nc0tfSCNAw0jvTD1M3ULPQXVO90MlZ6uN2WJfoEXwN+a55Y/kMeBh5FfmPuZu4Wfguudb4ZLz9ebs8S/IAoQby1yKx4o4iDCKC4s/CzcIk4h9C42I6QX6y1YEl9QBai3VrlVD1RxUGFUF1Z+Vm5Rp1B6V5tR0qv1ViypLxwFHG995PZ44BGHI4zHhQ8/H245TnHo/djMIf2x3gdLxxdsAfatbW7tA20cbBjtha2frVvsKaze7Was9Ha9LUuW/gP2ssBwaAAcBgAAAABJRU5ErkJggg==';

/**
 * The cast the identity showcases draw from: an agent with a live working
 * chip, an agent with none, a local person, a person carrying a photo, a
 * bridged external person, a room's own system voice, and the edge cases the
 * design doc calls out by name — a long name/handle pair, a light fill with no
 * emoji (the case `readableForeground` exists for), and multi-codepoint ZWJ
 * emoji.
 */
export const MOCK_IDENTITIES: Record<string, MockIdentity> = {
  warden: {
    kind: 'agent',
    displayName: 'Warden',
    handle: 'warden',
    color: '#6d5ae0',
    emoji: '🛡️',
    agent: {
      runtime: 'Claude Code',
      model: 'Opus 4.8',
      working: { forMs: 134_000 },
      managedBy: { displayName: 'Dorian', handle: 'dorian' },
    },
  },
  scout: {
    kind: 'agent',
    displayName: 'Scout',
    handle: 'scout',
    color: '#12a594',
    emoji: '🔭',
    agent: {
      runtime: 'Claude Code',
      model: 'Sonnet 5',
      // The other managed-by fallback: an owner the roster knows by name but
      // not yet by handle. Never a bare "@" — the display name stands in.
      managedBy: { displayName: 'Priya', handle: null },
    },
  },
  // No `managedBy` at all — today's honest state for every real card, since
  // no production caller populates it yet (that lands with the Team page).
  // Sits beside `warden`/`scout` so the three owner-attribution states —
  // handle, name-only, and no chip — are visible in the same row.
  courier: {
    kind: 'agent',
    displayName: 'Courier',
    handle: 'courier',
    color: '#e11d48',
    emoji: '📦',
    agent: { runtime: 'Claude Code', model: 'Sonnet 5' },
  },
  ana: {
    kind: 'human',
    displayName: 'Ana',
    handle: 'ana',
    origin: 'local',
  },
  // The photo case. A person, because the upload surface is for people only —
  // an agent's identity language is its emoji and its colour. The emoji sits
  // beside the photo on purpose: the disc draws the photo and the emoji is what
  // it falls back to, which is the precedence this cast member exists to show.
  photographed: {
    kind: 'human',
    displayName: 'Dorian',
    handle: 'dorian',
    color: '#0ea5e9',
    emoji: '🐙',
    imageUrl: MOCK_PHOTO,
    origin: 'local',
  },
  priya: {
    kind: 'human',
    displayName: 'Priya',
    handle: 'priya',
    origin: { platform: 'Telegram' },
  },
  roomNotice: {
    kind: 'system',
    displayName: 'General',
  },
  // Both halves are deliberately long, and the NAME is the longer of the two:
  // the pill wraps a long handle within a line, while a fixed-width identity row
  // truncates a long name — two different behaviours that need one cast member
  // long enough to trigger each. A name that merely looks long (40 characters)
  // fits the row it was meant to overflow and quietly proves nothing.
  longHandle: {
    kind: 'agent',
    displayName: 'Codebase Migration Orchestrator for the Northern Monorepo (staging)',
    handle: 'codebase-migration-orchestrator-v2',
    color: '#d4770a',
  },
  // No `emoji` — the fallback letter has to pick its own contrast against a
  // pale fill rather than assume white, exactly the case `readableForeground`
  // was added for.
  noEmojiFill: {
    kind: 'agent',
    displayName: 'Relay',
    handle: 'relay',
    color: '#fde68a',
  },
  multiCodepointEmoji: {
    kind: 'agent',
    displayName: 'Pair',
    handle: 'pair',
    color: '#0ea5e9',
    emoji: '🧑‍💻',
  },
  externalFlag: {
    kind: 'agent',
    displayName: 'Privateer',
    handle: 'privateer',
    color: '#334155',
    emoji: '🏴‍☠️',
  },
};

/**
 * A roster the product cannot produce yet, which is exactly why it exists.
 *
 * Two people, four agents and two owners. The spec's binding rule for the Buzz
 * future (§W2.6) is that no component may branch on "there is exactly one
 * person" — a rule that only means anything if something in the repo draws a
 * second one. This is that something: the playground renders the real Team page
 * against it, and the page's jsdom tests assert grouping, the owner filter and
 * the chips against these same rows, so the showcase and the tests cannot drift
 * into disagreeing about what a two-person install looks like.
 *
 * The edge cases the card has to survive ride along rather than living in a
 * second fixture: a person bridged in from another platform with a qualified
 * handle, an agent that belongs to nobody (the system one), an agent with no
 * handle at all, and a name long enough to need truncating.
 */
export const MOCK_TEAM_ROSTER: TeamMember[] = [
  {
    id: 'person-dorian',
    kind: 'human',
    displayName: 'Dorian',
    handle: 'dorian',
    color: '#6d5ae0',
    isSelf: true,
    ownerId: null,
    origin: 'local',
    person: { role: null, email: 'dorian@dorkos.ai', lastSeenAt: new Date().toISOString() },
  },
  {
    id: 'person-miguel',
    kind: 'human',
    displayName: 'Miguel Ferreira-Santos',
    // Qualified, because two platforms can each hold a `miguel` and the roster
    // has to be able to say which one this is.
    handle: 'miguel.telegram',
    color: '#0ea5e9',
    // The roster's photo case. On the SELF row it would be redundant with the
    // Account Menu and Profile Tab showcases, which already draw one; here it
    // also proves the Team card draws a photo for somebody who is not you —
    // the surface that silently dropped `imageUrl` until `teamMemberFace`
    // (DOR-979 review, N2).
    imageUrl: MOCK_PHOTO,
    isSelf: false,
    ownerId: null,
    origin: { platform: 'telegram' },
    // Nothing on this install dates a bridged person's presence, so the roster
    // says `null` rather than guessing — the case the header renders as the
    // platform line instead of "Last seen …".
    person: { role: null, lastSeenAt: null },
  },
  {
    id: 'agent-warden',
    kind: 'agent',
    displayName: 'Warden',
    handle: 'warden',
    color: '#6d5ae0',
    emoji: '🛡️',
    isSelf: false,
    ownerId: 'person-dorian',
    origin: 'local',
    agent: {
      manifestId: 'agent-warden',
      runtime: 'claude-code',
      model: 'opus-4.8',
      healthStatus: 'active',
      recentlyActive: true,
      projectPath: '/Users/dorian/agents/warden',
      // Mid-turn: the state the status sentence renders as
      // "Working in #team · 5 min".
      activity: {
        working: {
          roomId: 'room-team',
          roomName: 'team',
          since: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        },
        lastActiveAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      },
      isDefault: true,
      isSystem: false,
      registeredAt: '2026-07-01T09:00:00.000Z',
    },
  },
  {
    id: 'agent-scout',
    kind: 'agent',
    displayName: 'Scout',
    handle: 'scout',
    color: '#f59e0b',
    emoji: '🔭',
    isSelf: false,
    ownerId: 'person-dorian',
    origin: 'local',
    agent: {
      manifestId: 'agent-scout',
      runtime: 'codex',
      healthStatus: 'stale',
      recentlyActive: false,
      projectPath: '/Users/dorian/agents/scout',
      // Idle: "Last active 3 h ago".
      activity: {
        working: null,
        lastActiveAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      },
      isDefault: false,
      isSystem: false,
      registeredAt: '2026-07-04T14:20:00.000Z',
    },
  },
  {
    id: 'agent-cartographer',
    kind: 'agent',
    displayName: 'Cartographer of the Northern Reaches',
    // Never been in a room, so there is nothing to address it by.
    handle: null,
    color: '#0ea5e9',
    emoji: '🗺️',
    isSelf: false,
    ownerId: 'person-miguel',
    origin: 'local',
    agent: {
      manifestId: 'agent-cartographer',
      runtime: 'opencode',
      model: 'qwen3-coder',
      healthStatus: 'inactive',
      recentlyActive: false,
      // Never run: "Hasn't run yet", which is a different sentence from idle.
      activity: { working: null, lastActiveAt: null },
      isDefault: false,
      isSystem: false,
      registeredAt: '2026-07-06T11:05:00.000Z',
    },
  },
  {
    id: 'agent-dorkbot',
    kind: 'agent',
    displayName: 'DorkBot',
    handle: 'dorkbot',
    color: '#334155',
    emoji: '🤖',
    isSelf: false,
    // The system agent belongs to the install, not to a person.
    ownerId: null,
    origin: 'local',
    agent: {
      manifestId: 'agent-dorkbot',
      runtime: 'claude-code',
      healthStatus: 'active',
      recentlyActive: true,
      projectPath: '/Users/dorian/.dork/agents/dorkbot',
      activity: {
        working: null,
        lastActiveAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
      },
      isDefault: false,
      isSystem: true,
      registeredAt: '2026-06-20T08:00:00.000Z',
    },
  },
];

/**
 * The operator's own row on the rare install where an agent picked the name
 * (DOR-1022) — a derived variant rather than a second row in the roster above.
 *
 * `isSelf` is true for exactly one row and the fixture must keep that property,
 * so this is spread over the real self row at the demo that wants it. The COMMON
 * state stays primary: {@link MOCK_TEAM_ROSTER} carries no `nameSuggestedBy`,
 * which is what a person who saved their own name — or upgraded from before
 * this was recorded — actually sees.
 *
 * @param member - The operator's own roster row.
 * @param agentName - Who suggested the name, or `null` for an agent this install
 *   cannot identify (which renders "Suggested by an agent").
 * @returns The same row, carrying the provenance the payload would.
 */
export function withSuggestedName(member: TeamMember, agentName: string | null): TeamMember {
  return { ...member, person: { ...member.person!, nameSuggestedBy: agentName } };
}
