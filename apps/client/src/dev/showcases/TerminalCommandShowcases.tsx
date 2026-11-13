import type { TerminalCommandBridge, TerminalCommandStatus } from '@/layers/shared/lib';
import { TerminalCommandTab } from '@/layers/features/settings';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

const ADVICE = {
  path: '~/.local/bin/dorkos',
  shellFile: '~/.zshrc',
  line: "alias dorkos='~/.local/bin/dorkos'",
};

/** A desktop bridge that reports one state; Install fails with `failure` when given one. */
function fake(status: TerminalCommandStatus, failure?: string): TerminalCommandBridge {
  return {
    status: async () => status,
    install: async () => {
      if (failure) throw new Error(failure);
      return { state: 'installed', path: ADVICE.path };
    },
    remove: async () => ({ state: 'not-installed' }),
  };
}

/** The designer's five states (DOR-3105), plus a long path and a dev build. */
const STATES: { id: string; label: string; bridge: TerminalCommandBridge | null }[] = [
  { id: 'not-installed', label: '1. Not installed', bridge: fake({ state: 'not-installed' }) },
  {
    id: 'installed',
    label: '2. Installed, and Terminal finds it',
    bridge: fake({ state: 'installed', path: ADVICE.path }),
  },
  {
    id: 'not-found',
    label: '3. Installed, Terminal can’t find it',
    bridge: fake({ state: 'not-found', ...ADVICE }),
  },
  {
    id: 'shadowed',
    label: '4. Another dorkos first',
    bridge: fake({
      state: 'shadowed',
      ...ADVICE,
      otherPath: '/opt/homebrew/bin/dorkos',
      otherVersion: '0.98.0',
    }),
  },
  {
    id: 'shadowed-long',
    label: '4. Another dorkos first, long path, no version',
    bridge: fake({
      state: 'shadowed',
      ...ADVICE,
      shellFile: '~/.config/fish/config.fish',
      otherPath: '/Users/sam/.nvm/versions/node/v24.19.0/lib/node_modules/dorkos/dist/bin/cli.js',
      otherVersion: null,
    }),
  },
  {
    id: 'failed',
    label: '5. Install failed (press Install)',
    bridge: fake({ state: 'not-installed' }, 'another file is already at ~/.local/bin/dorkos.'),
  },
  { id: 'unavailable', label: 'Not the Mac app', bridge: null },
];

/**
 * Settings → This computer → Terminal command (DOR-3105). The tab shows only in
 * the desktop app, so each state here hands it a desktop bridge that reports it.
 */
export function TerminalCommandShowcases() {
  return (
    <PlaygroundSection
      title="Terminal Command"
      description="The Mac app's opt-in dorkos for the person's own Terminal, in each state the row can show."
    >
      {STATES.map((state) => (
        <div key={state.id} data-testid={`terminal-command-state-${state.id}`}>
          <ShowcaseLabel>{state.label}</ShowcaseLabel>
          <ShowcaseDemo>
            <div className="max-w-xl">
              <TerminalCommandTab bridge={state.bridge} />
            </div>
          </ShowcaseDemo>
        </div>
      ))}
    </PlaygroundSection>
  );
}
