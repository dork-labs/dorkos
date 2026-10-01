/**
 * What the channels page shows in place of a Community that is gone (DOR-2334), and what it says
 * never arrived there (DOR-2575).
 *
 * Nobody can produce these on demand: they need a host to delete a community or take it down,
 * or two weeks of "not found". The REAL panel, fed a descriptor per state and the person's
 * drafts through the real draft store, so the counts and the copy button are the ones the app
 * draws.
 *
 * @module dev/showcases/CommunityGoneShowcases
 */
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { useCommunityDraftStore } from '@/layers/entities/community';
import {
  confirmCommunityAuthority,
  getCommunityAuthority,
  getCommunityConnectionGeneration,
  invalidateCommunityAuthority,
} from '@/layers/shared/lib';
import { CommunityGonePanel } from '@/layers/widgets/room-view';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

const NONE = { read: false, post: false, enrollAgent: false, stream: false };

function connection(
  ref: string,
  over: Partial<CommunityConnectionDescriptor> & {
    lifecycle?: 'deleted' | 'taken_down';
  } = {}
): CommunityConnectionDescriptor {
  const { lifecycle, ...rest } = over;
  return {
    ref: ref as CommunityConnectionDescriptor['ref'],
    remoteCommunityId: `${ref}-id`,
    label: 'Night shift',
    pinnedOrigin: 'https://night-shift.example.com',
    connectedHumanMemberId: 'member',
    status: 'connected',
    expiresAt: null,
    access: {
      state: 'verified',
      effective: NONE,
      lastKnown: lifecycle
        ? { lifecycle, capabilities: NONE, verifiedAt: '2026-09-29T00:00:00.000Z' }
        : null,
    },
    attention: null,
    ...rest,
  };
}

/** Hold the drafts a person left in each gone Community, under a confirmed playground owner. */
function seedDrafts(): void {
  let authority = getCommunityAuthority();
  if (authority.ownerKey === null) {
    const next = invalidateCommunityAuthority();
    confirmCommunityAuthority(next.epoch, 'playground-owner');
    authority = getCommunityAuthority();
  }
  const write = (ref: string, roomId: string, text: string) =>
    useCommunityDraftStore.getState().write(
      {
        ownerKey: authority.ownerKey!,
        epoch: authority.epoch,
        ref,
        generation: getCommunityConnectionGeneration(ref),
        roomId,
      },
      { text, files: [] }
    );
  write('gone-deleted', 'general', 'Can someone check the night build before 6?');
  write('gone-seems', 'general', 'Draft for the weekly note');
  write('gone-seems', 'random', 'Half a reply to Ana');
}

const STATES: ReadonlyArray<{ label: string; connection: CommunityConnectionDescriptor }> = [
  {
    label: 'Deleted — three agent posts and one draft never arrived',
    connection: connection('gone-deleted', {
      lifecycle: 'deleted',
      undeliveredAgentMessages: 3,
    }),
  },
  {
    label: 'Taken down — everything had been sent, so nothing extra is said',
    connection: connection('gone-taken-down', { lifecycle: 'taken_down' }),
  },
  {
    label: 'Seems to be gone — only the person’s own drafts are named; the copy is still here',
    connection: connection('gone-seems', {
      access: { state: 'unverified', effective: NONE, lastKnown: null },
      seemsGoneSince: '2026-09-01T12:00:00.000Z',
    }),
  },
];

/** The gone Community panel, in each of its states. */
export function CommunityGoneShowcases() {
  // Seed once, before the first render reads the store.
  useState(seedDrafts);
  // Its own cache, as the delivery bench keeps one: removing reaches the stub transport only.
  const [queryClient] = useState(() => new QueryClient());
  return (
    <PlaygroundSection
      title="CommunityGonePanel"
      description="What stands in for a Community that was deleted, taken down by its host, or that has said for two weeks it doesn’t exist. Below the reason, one line says what never arrived: the agents’ posts the server counted before it removed its copy, and the person’s own unsent drafts, with a button to copy them before removing the Community clears them. Check that (a) the line reads plainly and only appears when something is missing, and (b) the two buttons sit together at phone width."
    >
      <QueryClientProvider client={queryClient}>
        <div className="space-y-6">
          {STATES.map((state) => (
            <div key={state.connection.ref} className="space-y-2">
              <ShowcaseLabel>{state.label}</ShowcaseLabel>
              <ShowcaseDemo responsive>
                <div className="flex min-h-[26rem] flex-col">
                  <CommunityGonePanel connection={state.connection} onRemoved={() => {}} />
                </div>
              </ShowcaseDemo>
            </div>
          ))}
        </div>
      </QueryClientProvider>
    </PlaygroundSection>
  );
}
