import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { LocalBrowserPersonState } from '@dorkos/shared/local-browser';
import { TransportProvider } from '@/layers/shared/model';
import { LocalBrowserPanel } from '@/layers/features/local-browser';
import { createPlaygroundTransport } from '../playground-transport';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** A browser nobody has opened yet. */
const NOT_OPEN: LocalBrowserPersonState = {
  connectionId: null,
  sessionId: null,
  mode: null,
  status: 'disconnected',
  paused: false,
  tabs: [],
  selectedTabId: null,
  revision: 0,
  preparation: null,
  handoff: null,
  signIn: null,
};

/** A browser another chat holds, in a separate window (DOR-4265). Made-up chat and agent. */
const IN_USE_ELSEWHERE: LocalBrowserPersonState = {
  ...NOT_OPEN,
  connectionId: 'demo-connection',
  sessionId: 'chat-scout',
  mode: 'new-window',
  status: 'connected',
  tabs: [{ id: 'demo-tab', title: 'Release notes draft', url: 'https://example.com/notes' }],
  selectedTabId: 'demo-tab',
};

/** The same browser while Scout waits for a person to finish a sign-in. */
const HOLDER_WAITING: LocalBrowserPersonState = {
  ...IN_USE_ELSEWHERE,
  paused: true,
  handoff: {
    id: 'demo-handoff',
    sessionId: 'chat-scout',
    agentName: 'Scout',
    agentId: null,
    agentFolder: null,
    profileId: null,
    reason: 'password',
    site: 'example.com',
    askedAt: '2026-11-13T12:00:00.000Z',
    outcome: null,
  },
};

/**
 * A scoped transport for one browser state, with a made-up holder chat.
 *
 * @param state - What the browser reports.
 * @param forget - What Forget does; the playground's own by default.
 */
function browserTransport(
  state: LocalBrowserPersonState,
  forget?: () => Promise<never>
): Transport {
  const base = createPlaygroundTransport();
  return new Proxy(base, {
    get: (target, prop, receiver) => {
      if (prop === 'getLocalBrowserState') return async () => state;
      if (prop === 'getSession')
        return async (id: string) => ({ id, title: 'Fix the release notes', cwd: '/agents/scout' });
      if (prop === 'getAgentByPath') return async () => ({ name: 'scout', displayName: 'Scout' });
      if (prop === 'getLocalBrowserCapabilities')
        return async () => ({ embedded: false, newWindow: true });
      if (prop === 'listLocalBrowserProfiles') return async () => ({ profiles: [] });
      if (prop === 'forgetLocalBrowserSignIns' && forget) return forget;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

/**
 * The panel in Atlas's chat reading one browser state, from a scoped transport and
 * its own query cache: the browser's state is one app-wide query, so demos sharing
 * the Playground's cache would all show whichever state loaded first.
 * `visible` stays off so several demos on one page don't pull focus and scroll.
 */
function PanelDemo({ state }: { state: LocalBrowserPersonState }) {
  const [transport] = useState<Transport>(() => browserTransport(state));
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <div className="bg-background h-[36rem] w-full max-w-sm rounded-lg border">
          <LocalBrowserPanel visible={false} sessionId="chat-atlas" agentName="Atlas" />
        </div>
      </TransportProvider>
    </QueryClientProvider>
  );
}

/**
 * Forget refused because the sign-ins folder was changed outside DorkOS (DOR-4172).
 * Press Forget… then Forget sign-ins: the dialog becomes the answer, with only Close.
 */
function FolderChangedDemo() {
  const [transport] = useState<Transport>(() =>
    browserTransport(NOT_OPEN, async () => {
      throw Object.assign(new Error('Sign-ins weren’t forgotten.'), {
        code: 'profiles_folder_changed',
      });
    })
  );
  return (
    <TransportProvider transport={transport}>
      <div className="bg-background h-[36rem] w-full max-w-sm rounded-lg border">
        <LocalBrowserPanel visible={false} sessionId="chat-atlas" agentName="Atlas" />
      </div>
    </TransportProvider>
  );
}

/**
 * The Agent browser panel before first use (DOR-4104): it says "Not open yet",
 * because "Disconnected" before anything was opened reads as broken.
 */
export function LocalBrowserPanelShowcases() {
  return (
    <PlaygroundSection
      title="Agent browser panel"
      description="The panel beside a chat that picks a browser and shares one page with that chat's agent."
    >
      <ShowcaseLabel>Before the browser was ever opened</ShowcaseLabel>
      <ShowcaseDemo>
        <PanelDemo state={NOT_OPEN} />
      </ShowcaseDemo>
      <ShowcaseLabel>In use in another chat: Use it here moves it</ShowcaseLabel>
      <ShowcaseDemo>
        <PanelDemo state={IN_USE_ELSEWHERE} />
      </ShowcaseDemo>
      <ShowcaseLabel>In use in another chat whose agent waits on a person</ShowcaseLabel>
      <ShowcaseDemo>
        <PanelDemo state={HOLDER_WAITING} />
      </ShowcaseDemo>
      <ShowcaseLabel>Forget refused: the sign-ins folder was changed outside DorkOS</ShowcaseLabel>
      <ShowcaseDemo>
        <FolderChangedDemo />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
