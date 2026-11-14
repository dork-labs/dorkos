import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { LocalBrowserPersonState } from '@dorkos/shared/local-browser';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import { useSessionListStore } from '@/layers/entities/session';
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

/** A browser held by a chat whose agent is working right now, with a long made-up title. */
const IN_USE_WORKING: LocalBrowserPersonState = {
  ...IN_USE_ELSEWHERE,
  sessionId: 'chat-scout-busy',
};

/** Made-up holder chat titles, one long enough to cut off. */
const HOLDER_TITLES: Record<string, string> = {
  'chat-scout': 'Fix the release notes',
  'chat-scout-busy': 'Fix the release notes and the changelog for the November launch',
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

/** Another chat holds a sign-in; this chat keeps its own readable tab. */
const pausedForSignIn: LocalBrowserPersonState = {
  ...NOT_OPEN,
  connectionId: 'playground-browser',
  sessionId: 'chat-kestrel',
  mode: 'new-window',
  status: 'connected',
  tabs: [{ id: 'kestrel-tab', title: 'Research notes', url: 'https://northwind.example' }],
  selectedTabId: 'kestrel-tab',
  signInElsewhere: { handoffId: 'playground-sign-in' },
};

/**
 * Atlas handed this chat's browser to a person in its own window (DOR-4325): the
 * agent's window closed for the sign-in window, which is open now.
 */
const WAITING_HERE: LocalBrowserPersonState = {
  ...NOT_OPEN,
  handoff: { ...HOLDER_WAITING.handoff!, sessionId: 'chat-atlas', agentName: 'Atlas' },
  signIn: {
    profileId: null,
    site: 'example.com',
    status: 'open',
    startedAt: '2026-11-13T12:00:01.000Z',
  },
};

/** The person closed the sign-in window and it saved; only Continue is left (DOR-4325). */
const WINDOW_CLOSED_HERE: LocalBrowserPersonState = {
  ...WAITING_HERE,
  signIn: { ...WAITING_HERE.signIn!, status: 'saved' },
};

/** Open browser refused while a sign-in window holds the profile (DOR-4325). */
async function refuseWhileSigningIn(): Promise<never> {
  throw Object.assign(new Error('Finish signing in first.'), { code: 'signing_in' });
}

/**
 * A scoped transport for one browser state, with a made-up holder chat.
 *
 * @param state - What the browser reports, or a reader for a state that changes.
 * @param forget - What Forget does; the playground's own by default.
 * @param open - What Open browser does; the playground's own by default.
 */
function browserTransport(
  state: LocalBrowserPersonState | (() => LocalBrowserPersonState),
  forget?: () => Promise<never>,
  open?: () => Promise<never>
): Transport {
  const base = createPlaygroundTransport();
  return new Proxy(base, {
    get: (target, prop, receiver) => {
      if (prop === 'getLocalBrowserState')
        return async () => (typeof state === 'function' ? state() : state);
      if (prop === 'getSession')
        return async (id: string) => ({ id, title: HOLDER_TITLES[id] ?? '', cwd: '/agents/scout' });
      if (prop === 'getAgentByPath') return async () => ({ name: 'scout', displayName: 'Scout' });
      if (prop === 'getLocalBrowserCapabilities')
        return async () => ({ embedded: false, newWindow: true });
      if (prop === 'listLocalBrowserProfiles') return async () => ({ profiles: [] });
      if (prop === 'forgetLocalBrowserSignIns' && forget) return forget;
      if (prop === 'openLocalBrowser' && open) return open;
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
function PanelDemo({
  state,
  open,
  afterOpen,
}: {
  state: LocalBrowserPersonState;
  open?: () => Promise<never>;
  /** What the browser reports once Open browser was pressed: a handoff that began meanwhile. */
  afterOpen?: LocalBrowserPersonState;
}) {
  const [transport] = useState<Transport>(() => {
    let current = state;
    return browserTransport(
      () => current,
      undefined,
      open &&
        (() => {
          if (afterOpen) current = afterOpen;
          return open();
        })
    );
  });
  useEffect(() => {
    if (state.sessionId !== IN_USE_WORKING.sessionId) return;
    // A live status is how the app knows a chat's agent is working right now.
    useSessionListStore.setState((store) => ({
      statuses: { ...store.statuses, [IN_USE_WORKING.sessionId!]: {} as SessionStatus },
    }));
  }, [state.sessionId]);
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
        <LocalBrowserPanel
          visible={false}
          sessionId="chat-atlas-folder-changed"
          agentName="Atlas"
        />
      </div>
    </TransportProvider>
  );
}

/** State 1.11, with a long made-up name to exercise wrapping at phone widths. */
function PausedForSignInDemo({ waiting = false }: { waiting?: boolean }) {
  // Playground examples share a QueryClient, so each state needs its own cache key.
  const sessionId = waiting ? 'chat-kestrel-waiting' : 'chat-kestrel';
  const [transport] = useState<Transport>(
    () =>
      new Proxy(browserTransport(NOT_OPEN), {
        get: (target, prop, receiver) => {
          if (prop === 'getLocalBrowserState' || prop === 'signInLocalBrowser')
            return async () =>
              waiting
                ? {
                    ...pausedForSignIn,
                    sessionId,
                    status: 'disconnected',
                    tabs: [],
                    selectedTabId: null,
                    signInElsewhere: null,
                    waitingForTab: true,
                    idleTabToClose: {
                      sessionId: 'chat-nova',
                      title: 'Northwind quarterly research and planning',
                    },
                    openChatTabs: [
                      {
                        sessionId: 'chat-nova',
                        title: 'Northwind quarterly research and planning',
                        origin: 'https://northwind.example',
                        state: 'Agent',
                        idle: true,
                      },
                    ],
                  }
                : pausedForSignIn;
          return Reflect.get(target, prop, receiver) as unknown;
        },
      })
  );
  return (
    <TransportProvider transport={transport}>
      <div className="bg-background h-[36rem] w-full max-w-lg rounded-lg border">
        <LocalBrowserPanel sessionId={sessionId} agentName="Kestrel the Research Assistant" />
      </div>
    </TransportProvider>
  );
}

/** Real person-state fixtures for holding a tab (1.5) and stopping its chat (1.7). */
function HeldTabDemo({ stopped = false }: { stopped?: boolean }) {
  const sessionId = stopped ? 'chat-kestrel-stopped' : 'chat-kestrel-held';
  const [transport] = useState<Transport>(() => {
    const state: LocalBrowserPersonState = {
      ...pausedForSignIn,
      sessionId,
      paused: true,
      signInElsewhere: null,
      handoffAttached: true,
      handoffTaken: !stopped,
      handoff: {
        id: stopped ? 'playground-stopped-handoff' : 'playground-held-handoff',
        sessionId,
        site: 'northwind.example',
        profileId: null,
        agentName: 'Kestrel the Research Assistant',
        agentId: null,
        agentFolder: null,
        reason: 'password',
        askedAt: '2026-11-14T00:00:00.000Z',
        outcome: stopped ? 'stopped' : null,
      },
    };
    return new Proxy(browserTransport(NOT_OPEN), {
      get: (target, prop, receiver) => {
        if (prop === 'getLocalBrowserState') return async () => state;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
  });
  return (
    <TransportProvider transport={transport}>
      <div className="bg-background h-[36rem] w-full max-w-lg rounded-lg border">
        <LocalBrowserPanel sessionId={sessionId} agentName="Kestrel the Research Assistant" />
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
      <ShowcaseLabel>In use in another chat: Take it here moves it</ShowcaseLabel>
      <ShowcaseDemo>
        <PanelDemo state={IN_USE_ELSEWHERE} />
      </ShowcaseDemo>
      <ShowcaseLabel>In use by an agent working right now, with a long title</ShowcaseLabel>
      <ShowcaseDemo>
        <PanelDemo state={IN_USE_WORKING} />
      </ShowcaseDemo>
      <ShowcaseLabel>In use in another chat whose agent waits on a person</ShowcaseLabel>
      <ShowcaseDemo>
        <PanelDemo state={HOLDER_WAITING} />
      </ShowcaseDemo>
      <ShowcaseLabel>This chat’s agent waits on you in the sign-in window</ShowcaseLabel>
      <ShowcaseDemo>
        <PanelDemo state={WAITING_HERE} />
      </ShowcaseDemo>
      <ShowcaseLabel>This chat’s agent waits on you after the sign-in window closed</ShowcaseLabel>
      <ShowcaseDemo>
        <PanelDemo state={WINDOW_CLOSED_HERE} />
      </ShowcaseDemo>
      <ShowcaseLabel>Open browser refused while signing in: press Open browser</ShowcaseLabel>
      <ShowcaseDemo>
        <PanelDemo state={NOT_OPEN} open={refuseWhileSigningIn} />
      </ShowcaseDemo>
      <ShowcaseLabel>
        Refused because this chat’s agent just handed over: press Open browser
      </ShowcaseLabel>
      <ShowcaseDemo>
        <PanelDemo state={NOT_OPEN} open={refuseWhileSigningIn} afterOpen={WAITING_HERE} />
      </ShowcaseDemo>
      <ShowcaseLabel>Forget refused: the sign-ins folder was changed outside DorkOS</ShowcaseLabel>
      <ShowcaseDemo>
        <FolderChangedDemo />
      </ShowcaseDemo>
      <ShowcaseLabel>You have it (1.5)</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <HeldTabDemo />
      </ShowcaseDemo>
      <ShowcaseLabel>Fell to you (1.7)</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <HeldTabDemo stopped />
      </ShowcaseDemo>
      <ShowcaseLabel>Paused for a sign-in elsewhere (1.11)</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <PausedForSignInDemo />
      </ShowcaseDemo>
      <ShowcaseLabel>Waiting for a tab (1.12)</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <PausedForSignInDemo waiting />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
