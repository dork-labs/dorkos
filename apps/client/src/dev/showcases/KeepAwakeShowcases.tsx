import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { KeepAwakeStatus } from '@dorkos/shared/schemas';
import { Button } from '@/layers/shared/ui';
import { KEEP_AWAKE_KEY, useKeepAwake } from '@/layers/entities/keep-awake';
import { KeepAwakeBeacon } from '@/layers/widgets/keep-awake';
import { SleepSettings } from '@/layers/features/settings';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

const IDLE: KeepAwakeStatus = {
  enabled: true,
  supported: true,
  reason: null,
  asserted: false,
  working: { chats: 0, rooms: 0, tasks: 0, waking: false },
  wake: { enabled: false, setup: 'unsupported', nextWakeAt: null, setupCommand: null },
};

/**
 * The states the server can report. Each button writes the status into the
 * real query cache, the way the `keep_awake_status` event does, so the cup and
 * the card draw exactly what the app would.
 */
const STATES: { label: string; status: KeepAwakeStatus }[] = [
  { label: 'Idle', status: IDLE },
  {
    label: 'Two chats',
    status: { ...IDLE, asserted: true, working: { ...IDLE.working, chats: 2 } },
  },
  {
    label: 'Mixed',
    status: { ...IDLE, asserted: true, working: { chats: 1, rooms: 1, tasks: 1, waking: false } },
  },
  {
    label: 'Setting off',
    status: { ...IDLE, enabled: false, working: { ...IDLE.working, chats: 1 } },
  },
  { label: 'Container', status: { ...IDLE, supported: false, reason: 'container' } },
  { label: 'Tool missing', status: { ...IDLE, supported: false, reason: 'tool-missing' } },
  { label: 'Refused', status: { ...IDLE, supported: false, reason: 'denied' } },
];

/** The buttons that pose the status, plus what it currently says. */
function StateDriver() {
  const queryClient = useQueryClient();
  const status = useKeepAwake();

  // The cache outlives this page, so the posed status does not follow the
  // visitor to the next showcase.
  useEffect(
    () => () => queryClient.removeQueries({ queryKey: [...KEEP_AWAKE_KEY] }),
    [queryClient]
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {STATES.map((entry) => (
        <Button
          key={entry.label}
          variant="outline"
          size="sm"
          onClick={() => queryClient.setQueryData([...KEEP_AWAKE_KEY], entry.status)}
        >
          {entry.label}
        </Button>
      ))}
      <span className="text-muted-foreground ml-2 font-mono text-xs">
        asserted: {String(status?.asserted ?? false)} · supported:{' '}
        {String(status?.supported ?? '—')}
      </span>
    </div>
  );
}

/**
 * Keep awake (spec `keep-awake`): the top-bar cup and the Settings → Tools →
 * Sleep card, on the one status. Press a state and both move together.
 */
export function KeepAwakeShowcases() {
  return (
    <PlaygroundSection
      title="Keep Awake"
      description="The top-bar cup and the Sleep card, on one status. The cup appears only while the computer is held awake for work; the card disables itself and says why where it cannot be."
    >
      <ShowcaseLabel>Drive the state</ShowcaseLabel>
      <ShowcaseDemo>
        <StateDriver />
      </ShowcaseDemo>

      <ShowcaseLabel>The cup, in a stand-in top bar</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="border-border flex h-9 items-center justify-end gap-1 rounded-md border px-2">
          <KeepAwakeBeacon />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Settings → Tools → Sleep</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="max-w-lg">
          <SleepSettings />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
