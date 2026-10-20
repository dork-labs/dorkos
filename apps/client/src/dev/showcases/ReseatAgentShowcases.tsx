/**
 * "Continue on another account…" for an agent in a room or DM (re-seat): the
 * picker over each answer the server can give, so its states can be checked in
 * both themes and on a phone without a room whose agent ran out.
 */
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReseatOptions } from '@dorkos/shared/room-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/layers/shared/ui';
import { ReseatAgentDialog, ReseatMenuItem } from '@/layers/features/reseat-agent';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { createPlaygroundTransport } from '../playground-transport';
import { MOCK_ACCOUNT_USAGE } from './account-mock-data';

/** One account the picker lists, from the shared account fixtures. */
function account(n: number, eligible = true, reason = ''): ReseatOptions['accounts'][number] {
  const usage = MOCK_ACCOUNT_USAGE[n - 1]!;
  return { id: usage.accountId!, label: usage.label, color: usage.color, eligible, reason };
}

const CURRENT = { id: MOCK_ACCOUNT_USAGE[0]!.accountId!, label: MOCK_ACCOUNT_USAGE[0]!.label };

const SOME: ReseatOptions = {
  current: CURRENT,
  seated: true,
  accounts: [
    account(2),
    account(3, false, 'Almost out of usage'),
    account(4, false, 'Out until Tue 3pm'),
  ],
};

const NONE: ReseatOptions = {
  current: CURRENT,
  seated: true,
  accounts: [account(2, false, 'Out until Tue 3pm'), account(3, false, 'Almost out of usage')],
};

/** The agent has not answered in this room yet, so there is no seat to move. */
const UNSEATED: ReseatOptions = { current: null, accounts: [], seated: false };

/** The playground transport answering this variant's options, and optionally refusing the move. */
function variantTransport(answer: ReseatOptions, moveError?: Error): Transport {
  const base = createPlaygroundTransport();
  return new Proxy(base, {
    get: (target, prop, receiver) => {
      if (prop === 'getRoomReseatOptions') return async () => answer;
      if (prop === 'reseatRoomAgent') {
        return async () => {
          if (moveError) throw moveError;
          return { sessionId: 'playground-reseated' };
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

/** One labelled variant: a button that opens the real picker over its own transport. */
function Variant({
  label,
  answer,
  moveError,
}: {
  label: string;
  answer: ReseatOptions;
  moveError?: Error;
}) {
  const [open, setOpen] = useState(false);
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [transport] = useState(() => variantTransport(answer, moveError));
  return (
    <>
      <ShowcaseLabel>{label}</ShowcaseLabel>
      <ShowcaseDemo>
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              Open the picker
            </Button>
            <ReseatAgentDialog
              open={open}
              onOpenChange={setOpen}
              roomId="playground-room"
              authorId="playground-agent"
              agentName="dorkos-qa"
            />
          </TransportProvider>
        </QueryClientProvider>
      </ShowcaseDemo>
    </>
  );
}

/** One labelled menu: the member's "…" menu with the entry, over its own transport. */
function MenuVariant({ label, answer }: { label: string; answer: ReseatOptions }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [transport] = useState(() => variantTransport(answer));
  return (
    <>
      <ShowcaseLabel>{label}</ShowcaseLabel>
      <ShowcaseDemo>
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  Open the menu
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <ReseatMenuItem
                  roomId="playground-room"
                  authorId="playground-agent"
                  agentName="dorkos-qa"
                  onRequested={() => {}}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </TransportProvider>
        </QueryClientProvider>
      </ShowcaseDemo>
    </>
  );
}

/**
 * The seat picker for each answer the server can give, shown inside the
 * ContinueOnAccountDialog section: it is the same picker, for a room agent.
 */
export function ReseatAgentVariants() {
  return (
    <>
      <Variant
        label="Room agent — accounts to pick from, the best one picked, the rest say why not"
        answer={SOME}
      />
      <Variant
        label="Room agent — nothing left: every other account is out, one Close button"
        answer={NONE}
      />
      <Variant
        label="Room agent — refused, the agent is answering right now"
        answer={SOME}
        moveError={new Error('dorkos-qa is answering here right now. Move it when it’s done.')}
      />
      <MenuVariant label="Member menu — the entry, ready to open the picker" answer={SOME} />
      <MenuVariant label="Member menu — disabled, nothing left on any account" answer={NONE} />
      <MenuVariant
        label="Member menu — disabled, the agent hasn’t answered yet"
        answer={UNSEATED}
      />
    </>
  );
}
