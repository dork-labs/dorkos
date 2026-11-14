import { useState } from 'react';
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
 * A scoped transport for a browser that was never opened.
 *
 * @param forget - What Forget does; the playground's own by default.
 */
function notOpenTransport(forget?: () => Promise<never>): Transport {
  const base = createPlaygroundTransport();
  return new Proxy(base, {
    get: (target, prop, receiver) => {
      if (prop === 'getLocalBrowserState') return async () => NOT_OPEN;
      if (prop === 'getLocalBrowserCapabilities')
        return async () => ({ embedded: false, newWindow: true });
      if (prop === 'listLocalBrowserProfiles') return async () => ({ profiles: [] });
      if (prop === 'forgetLocalBrowserSignIns' && forget) return forget;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

/** The panel reading a browser that was never opened, from a scoped transport. */
function NotOpenDemo() {
  const [transport] = useState<Transport>(() => notOpenTransport());
  return (
    <TransportProvider transport={transport}>
      <div className="bg-background h-[36rem] w-full max-w-sm rounded-lg border">
        <LocalBrowserPanel sessionId="chat-atlas" agentName="Atlas" />
      </div>
    </TransportProvider>
  );
}

/**
 * Forget refused because the sign-ins folder was changed outside DorkOS (DOR-4172).
 * Press Forget… then Forget sign-ins: the dialog becomes the answer, with only Close.
 */
function FolderChangedDemo() {
  const [transport] = useState<Transport>(() =>
    notOpenTransport(async () => {
      throw Object.assign(new Error('Sign-ins weren’t forgotten.'), {
        code: 'profiles_folder_changed',
      });
    })
  );
  return (
    <TransportProvider transport={transport}>
      <div className="bg-background h-[36rem] w-full max-w-sm rounded-lg border">
        <LocalBrowserPanel sessionId="chat-atlas-folder-changed" agentName="Atlas" />
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
      new Proxy(notOpenTransport(), {
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
      handoffAttached: !stopped,
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
    return new Proxy(notOpenTransport(), {
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
        <NotOpenDemo />
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
      <p className="text-muted-foreground text-sm">
        Stopped handoffs currently show Agent paused; the hand-back controls are missing.
      </p>
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
