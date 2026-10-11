import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RemoteAccessReport } from '@dorkos/shared/types';
import { Button } from '@/layers/shared/ui';
import {
  remoteAccessKeys,
  resetRemoteAccessStore,
  useRemoteAccessStore,
} from '@/layers/entities/tunnel';
import { RemoteAccessTab } from '@/layers/features/settings/ui/RemoteAccessTab';
import { RemoteAccessRow } from '@/layers/widgets/control-center';
import { RemoteAccessBeacon, RemoteAccessPanel } from '@/layers/widgets/remote-access';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { setPlaygroundRemoteReport } from '../playground-transport';

const DEMO_URL = 'https://calm-otter.ngrok.app';
const MANAGED_URL = 'https://calm-otter.example.com';

/** A managed report, as the server would send it once DorkOS is chosen. */
function managedReport(overrides: Partial<RemoteAccessReport>): RemoteAccessReport {
  return {
    mode: 'managed',
    state: 'open',
    url: MANAGED_URL,
    alwaysAvailable: false,
    cloudStale: false,
    availability: 'available',
    enrolment: { status: 'enrolled' },
    ...overrides,
  };
}

/** Not yet set up: DorkOS offered, nothing chosen. */
const NOT_CHOSEN: Partial<RemoteAccessReport> = { mode: 'off', state: 'off', url: undefined };

/** How a state is posed: through the store, or as the server's report. */
interface Pose {
  /** Back to the person's own ngrok, and hand back the store's actions. */
  ngrok: () => ReturnType<typeof useRemoteAccessStore.getState>;
  /** Answer with this report, the way the server would. */
  managed: (report: RemoteAccessReport) => void;
}

/**
 * Put the shared model in one of its states, the way an action would.
 *
 * Every button below drives the REAL store through the REAL store actions, or,
 * for DorkOS states (DOR-2086), the real report query through the playground
 * transport, so what the playground draws is what the app draws.
 */
const STATES: { label: string; drive: (pose: Pose) => void }[] = [
  // First, and the state the page opens in: the playground's transport reports
  // no tunnel at all, which is exactly "nothing set up yet".
  { label: 'Never set up', drive: (pose) => void pose.ngrok() },
  { label: 'Off', drive: (pose) => setUp(pose.ngrok()) },
  { label: 'Connecting', drive: (pose) => setUp(pose.ngrok()).beginStart() },
  { label: 'On', drive: (pose) => setUp(pose.ngrok()).settleStart(DEMO_URL) },
  { label: 'Reconnecting', drive: (pose) => setUp(pose.ngrok()).convergeStart(DEMO_URL) },
  { label: 'Turning off', drive: (pose) => setUp(pose.ngrok()).beginStop() },
  {
    label: 'Failed',
    drive: (pose) => setUp(pose.ngrok()).failStart('ERR_NGROK_105 invalid auth token'),
  },
  { label: 'DorkOS: choose', drive: (pose) => pose.managed(managedReport(NOT_CHOSEN)) },
  {
    label: 'DorkOS: approving',
    drive: (pose) =>
      pose.managed(
        managedReport({
          ...NOT_CHOSEN,
          enrolment: {
            status: 'pending',
            userCode: 'WXYZ-1234',
            approveUrl: 'https://example.com/approve',
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          },
        })
      ),
  },
  {
    label: 'DorkOS: declined',
    drive: (pose) =>
      pose.managed(managedReport({ ...NOT_CHOSEN, enrolment: { status: 'denied' } })),
  },
  {
    label: 'DorkOS: timed out',
    drive: (pose) =>
      pose.managed(managedReport({ ...NOT_CHOSEN, enrolment: { status: 'expired' } })),
  },
  { label: 'DorkOS: on', drive: (pose) => pose.managed(managedReport({})) },
  {
    label: 'DorkOS: closed for now',
    drive: (pose) => pose.managed(managedReport({ state: 'asleep' })),
  },
  {
    label: 'DorkOS: blocked',
    drive: (pose) =>
      pose.managed(
        managedReport({
          state: 'blocked',
          url: undefined,
          reason: 'DorkOS Cloud is not opening this address right now.',
        })
      ),
  },
  {
    label: 'DorkOS: Cloud unreachable',
    drive: (pose) =>
      pose.managed(
        managedReport({
          state: 'off',
          url: undefined,
          cloudStale: true,
          availability: 'unavailable',
        })
      ),
  },
];

/**
 * Pretend the one-time ngrok setup is done, and hand back the store's actions.
 *
 * Every ngrok state except the first needs it: the playground's transport
 * reports no tunnel block, so the shared model correctly reads "no token
 * saved" and the row would offer setup instead of a switch.
 */
function setUp(store: ReturnType<typeof useRemoteAccessStore.getState>) {
  store.noteTokenConfigured(true);
  return store;
}

/** The buttons that pose the shared model, plus what it currently says. */
function StateDriver() {
  const queryClient = useQueryClient();
  const state = useRemoteAccessStore((s) => s.state);
  const tokenConfigured = useRemoteAccessStore((s) => s.tokenConfigured);
  const mode = useRemoteAccessStore((s) => s.report?.mode ?? 'ngrok only');

  // The store is module-scope and outlives this page, so whatever state the
  // last visitor left it posed in does not follow them to the next showcase.
  useEffect(
    () => () => {
      setPlaygroundRemoteReport(null);
      resetRemoteAccessStore();
    },
    []
  );

  const pose: Pose = {
    ngrok: () => {
      setPlaygroundRemoteReport(null);
      resetRemoteAccessStore();
      void queryClient.invalidateQueries({ queryKey: remoteAccessKeys.all });
      return useRemoteAccessStore.getState();
    },
    managed: (report) => {
      setPlaygroundRemoteReport(report);
      void queryClient.invalidateQueries({ queryKey: remoteAccessKeys.all });
    },
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {STATES.map((entry) => (
        <Button key={entry.label} variant="outline" size="sm" onClick={() => entry.drive(pose)}>
          {entry.label}
        </Button>
      ))}
      <span className="text-muted-foreground ml-2 font-mono text-xs">
        state: {state} · mode: {mode} · token: {String(tokenConfigured)}
      </span>
    </div>
  );
}

/**
 * Remote access in the app's chrome (DOR-1743) — the Control Center's top row
 * and the top-bar beacon, driven through every state they can reach.
 *
 * The two surfaces are shown TOGETHER on purpose: they read one shared model,
 * and the bug this design exists to prevent is the row and the beacon
 * disagreeing. Press a state and both should move at once.
 */
export function RemoteAccessShowcases() {
  return (
    <PlaygroundSection
      title="Remote Access"
      description="The Control Center's Remote-access row, Settings and the top-bar beacon, on the one shared model. Press a state: every surface moves together. The DorkOS states pose the server's report; the beacon appears only while remote access is live."
    >
      <ShowcaseLabel>Drive the state</ShowcaseLabel>
      <ShowcaseDemo>
        <StateDriver />
      </ShowcaseDemo>

      <ShowcaseLabel>The Control Center row</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="max-w-sm">
          <RemoteAccessRow />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Settings: the mode choice, DorkOS setup and status</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="max-w-md">
          <RemoteAccessTab />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>The beacon, in a stand-in top bar</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="border-border flex h-9 items-center justify-end gap-1 rounded-md border px-2">
          <RemoteAccessBeacon />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        What the beacon opens — QR first on a desktop, link first on a phone (narrow the window to
        see the flip)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="border-border w-72 rounded-lg border p-3">
          <RemoteAccessPanel onClose={() => {}} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
