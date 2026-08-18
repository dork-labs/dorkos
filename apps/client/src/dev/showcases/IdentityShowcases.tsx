import type * as React from 'react';
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { agentAuthorRef, type RoomEntry } from '@dorkos/shared/room-schemas';
import { MentionPill, IdentityHoverCard } from '@/layers/shared/ui';
import {
  AgentInfoProvider,
  RoomMessage,
  agentFacesByRef,
  type RoomAgentDirectory,
  type RosterAgentInfo,
} from '@/layers/widgets/room-view';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { MOCK_IDENTITIES, type MockIdentity } from '../mock-samples';
import { Conversation } from '@/layers/features/conversation';
import { ROOM_CAPABILITIES } from '@/layers/widgets/room-view';

/**
 * A mention pill on its own, as it would sit anywhere else — never inside a
 * flowing sentence, so the wrap showcase below is the only place that draws
 * one in running text.
 */
function Pill({
  identity,
  ...rest
}: { identity: MockIdentity } & Partial<
  Omit<React.ComponentProps<typeof MentionPill>, 'kind' | 'label' | 'color' | 'origin' | 'handle'>
>) {
  return (
    <MentionPill
      kind={identity.kind}
      label={identity.displayName}
      handle={identity.handle}
      color={identity.color}
      origin={identity.origin}
      resolved
      {...rest}
    />
  );
}

/**
 * A hover-card trigger, styled like the pill or avatar it would wrap in the
 * real feed — the card itself only draws once the pointer sits on this.
 */
function Trigger({
  identity,
  onViewProfile,
}: {
  identity: MockIdentity;
  onViewProfile?: () => void;
}) {
  return (
    <IdentityHoverCard identity={identity} onViewProfile={onViewProfile}>
      <button
        type="button"
        className="hover:bg-accent focus-visible:ring-ring rounded-md border px-2.5 py-1.5 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
      >
        {identity.displayName}
      </button>
    </IdentityHoverCard>
  );
}

/** Stands in for `useProfileDeepLink().open(id)` — the bench has no roster to open. */
function benchViewProfile(identity: MockIdentity) {
  return () => window.alert(`Would open the profile drawer for ${identity.displayName}`);
}

// --- A mention inside a real message ------------------------------------

/** Where the benched agent "lives" — both halves of the join derive from this. */
const WARDEN_PATH = '/w/warden';
const WARDEN_REF = agentAuthorRef(WARDEN_PATH);

/**
 * What the fleet would have said about Warden, keyed the way the real join keys
 * it. `memberId` is the roster id the pill's click carries — the id space the
 * room itself does not hold for an agent.
 */
const BENCH_AGENT_INFO: ReadonlyMap<string, RosterAgentInfo> = new Map([
  [
    WARDEN_REF,
    {
      memberId: 'agent-warden-manifest',
      // The face the real join would have resolved off Warden's manifest.
      visual: { color: '#6d5ae0', emoji: '🛡️' },
      runtime: 'Claude Code',
      model: 'opus',
    },
  ],
]);

/**
 * The same answer in the shape the room's own provider hands down: how each
 * agent runs, and the face every disc and pill in the subtree draws it with.
 */
const BENCH_DIRECTORY: RoomAgentDirectory = {
  info: BENCH_AGENT_INFO,
  faces: agentFacesByRef(BENCH_AGENT_INFO),
};

const BENCH_TEXT = 'can you take a look at the failing build, @warden?';

/** One real room entry with one real, server-spanned mention in it. */
const BENCH_ENTRY: RoomEntry = {
  roomId: 'bench-room',
  seq: 1,
  id: 'bench-mention-entry',
  authorId: 'author-ana',
  kind: 'post',
  body: { text: BENCH_TEXT },
  mentions: ['author-warden'],
  mentionSpans: [
    {
      offset: BENCH_TEXT.indexOf('@warden'),
      length: '@warden'.length,
      authorId: 'author-warden',
    },
  ],
  sessionId: null,
  cascadeRoot: 'bench-mention-entry',
  cascadeDepth: 0,
  parentEntryId: null,
  threadRootEntryId: null,
  signature: null,
  createdAt: '2026-08-06T10:00:00.000Z',
};

/**
 * The bench room's roster — the only place a resolved pill's identity comes
 * from, and where the `agentRef` the card looks the runtime up by lives.
 */
const BENCH_AUTHORS = new Map([
  [
    'author-ana',
    {
      id: 'author-ana',
      kind: 'human' as const,
      displayName: 'Ana',
      handle: 'ana',
      origin: 'local' as const,
    },
  ],
  [
    'author-warden',
    {
      id: 'author-warden',
      kind: 'agent' as const,
      displayName: 'Warden',
      handle: 'warden',
      color: '#6d5ae0',
      emoji: '🛡️',
      agentRef: WARDEN_REF,
      origin: 'local' as const,
    },
  ],
]);

/**
 * The card as a person actually meets it: hovering an `@mention` in a real
 * message row, not a trigger built for the bench.
 *
 * **Worth its own section because the two halves join here and nowhere else.**
 * The pill's name, colour and handle come from the room's roster; the runtime
 * and model come from the fleet's manifests, and the card is the only place
 * they are seen together. The card above this one is fed a descriptor by hand,
 * so it can look right while the join is broken — which is exactly what shipped
 * before DOR-954.
 *
 * `AgentInfoProvider` is fed by hand here; the routed app feeds it
 * `useRoomAgentDirectory`. The
 * pill reads the runtime from CONTEXT (Streamdown's top-level memo comparator
 * does not include `components`, so a prop cannot reach an already-drawn pill),
 * and without a provider above it the bench could only ever show a bare card.
 */
function MentionInAMessageSection() {
  const client = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
    []
  );
  return (
    <PlaygroundSection
      title="A mention in a real message"
      description="The whole path, end to end: a server-spanned @mention inside the real RoomMessage, resolved against a roster, with the agent's runtime and model joined in from the fleet. Hover the pill. Warden is seeded as a known agent, so its card carries the runtime chip; Ana is a person and carries her origin instead. Mention an agent the fleet has no manifest for and the chip is simply absent — never a placeholder."
    >
      <ShowcaseLabel>
        Hover @warden — name and handle from the roster, runtime from the fleet
      </ShowcaseLabel>
      <ShowcaseDemo>
        <QueryClientProvider client={client}>
          <AgentInfoProvider known={BENCH_DIRECTORY}>
            <Conversation.Root surface="room" capabilities={ROOM_CAPABILITIES} anchor="rail">
              <RoomMessage
                roomId="bench-room"
                entry={BENCH_ENTRY}
                author={{ id: 'author-ana', kind: 'human', displayName: 'Ana' }}
                authorRef={BENCH_AUTHORS.get('author-ana')}
                authors={BENCH_AUTHORS}
                viewerAuthorId="author-you"
                authorNames={new Map([['author-ana', 'Ana']])}
                reactionFrequents={[]}
                grouping={{ position: 'only' }}
              />
            </Conversation.Root>
          </AgentInfoProvider>
        </QueryClientProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** MentionPill and IdentityHoverCard showcases — the two new identity surfaces (spec `composer-identity-components`). */
export function IdentityShowcases() {
  return (
    <>
      <PlaygroundSection
        title="MentionPill"
        description="A resolved @mention, styled by who it points at: an agent wears its own colour with a Bot glyph in place of the @; a person is a neutral @name pill; unresolved text carries no pill and no pointer at all."
      >
        <ShowcaseLabel>Agent, human, external, system</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap items-center gap-2">
            <Pill identity={MOCK_IDENTITIES.warden} />
            <Pill identity={MOCK_IDENTITIES.scout} />
            <Pill identity={MOCK_IDENTITIES.ana} />
            <Pill identity={MOCK_IDENTITIES.priya} />
            <Pill identity={MOCK_IDENTITIES.roomNotice} />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Unresolved — plain text, no pill, no pointer</ShowcaseLabel>
        <ShowcaseDemo>
          <p className="text-sm">
            can you loop in{' '}
            <MentionPill kind="human" label="someone-not-in-room" resolved={false} /> on this?
          </p>
        </ShowcaseDemo>

        <ShowcaseLabel>
          Interactive — the cursor and focus ring a pill wears once its click opens a profile
        </ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap items-center gap-2">
            <Pill identity={MOCK_IDENTITIES.warden} interactive />
            <Pill identity={MOCK_IDENTITIES.ana} interactive />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>
          Long handle in running text — wraps within the line, never truncates
        </ShowcaseLabel>
        <ShowcaseDemo>
          <p className="max-w-xs text-sm">
            can you rebase this onto <Pill identity={MOCK_IDENTITIES.longHandle} /> before the
            freeze?
          </p>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="IdentityHoverCard"
        description="The compact card that opens over an identity: name, @handle subtitle, a couple of fact chips, and a footer that opens the profile drawer. Opens on pointer hover, keyboard focus, or (touch devices only) a long-press on the trigger — a quick tap goes straight to the profile instead."
      >
        <ShowcaseLabel>
          The footer, both ways — wired to a profile, and left unwired where the surface has no id
          to open one with
        </ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap gap-3">
            <Trigger
              identity={MOCK_IDENTITIES.warden}
              onViewProfile={benchViewProfile(MOCK_IDENTITIES.warden)}
            />
            <Trigger identity={MOCK_IDENTITIES.ana} />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Agent — working, and idle</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap gap-3">
            <Trigger identity={MOCK_IDENTITIES.warden} />
            <Trigger identity={MOCK_IDENTITIES.scout} />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>
          Owner attribution — &quot;Managed by @handle&quot;, by name when the owner has none yet,
          and no chip at all when the roster has no owner on file
        </ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap gap-3">
            <Trigger identity={MOCK_IDENTITIES.warden} />
            <Trigger identity={MOCK_IDENTITIES.scout} />
            <Trigger identity={MOCK_IDENTITIES.courier} />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Person — local, and bridged from an external platform</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap gap-3">
            <Trigger identity={MOCK_IDENTITIES.ana} />
            <Trigger identity={MOCK_IDENTITIES.priya} />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>
          Person with a photo — the photo is the face, and the emoji beside it is only what it falls
          back to
        </ShowcaseLabel>
        <ShowcaseDemo>
          <Trigger identity={MOCK_IDENTITIES.photographed} />
        </ShowcaseDemo>

        <ShowcaseLabel>System — the room&apos;s own voice, no chips, no handle</ShowcaseLabel>
        <ShowcaseDemo>
          <Trigger identity={MOCK_IDENTITIES.roomNotice} />
        </ShowcaseDemo>

        <ShowcaseLabel>Edge cases — long name/handle, light fill, ZWJ emoji</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap gap-3">
            <Trigger identity={MOCK_IDENTITIES.longHandle} />
            <Trigger identity={MOCK_IDENTITIES.noEmojiFill} />
            <Trigger identity={MOCK_IDENTITIES.multiCodepointEmoji} />
            <Trigger identity={MOCK_IDENTITIES.externalFlag} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <MentionInAMessageSection />
    </>
  );
}
