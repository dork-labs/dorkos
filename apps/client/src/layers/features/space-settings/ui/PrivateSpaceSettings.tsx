import { Lock } from 'lucide-react';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { initialOf, tileColor } from '../lib/space-view';
import { LetterTile, LockedReason, SettingsRow, SettingsSection } from './SettingsBlocks';
import { SettingsColumn } from './SpaceSettingsPanel';

/**
 * The private space's Settings tab (DOR-3005): on a hub, this DorkOS is a space only its owner
 * is in. Its name and icon are fixed here, nobody can be invited, and it has no roles or rules.
 * It cannot be left or deleted, and it has no web page of its own, so nothing here leads to one.
 */
export function PrivateSpaceSettings() {
  const agents = useRegisteredAgents().data?.agents ?? [];
  return (
    <SettingsColumn>
      <header className="flex items-center gap-4">
        <span className="bg-muted inline-flex size-12 shrink-0 items-center justify-center rounded-xl">
          <Lock aria-hidden className="size-5" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-lg font-semibold">Private</h2>
          <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <Lock aria-hidden className="size-3" />
            Just you and your agents
          </p>
        </div>
      </header>

      <SettingsSection title="General" testId="space-settings-general">
        <SettingsRow label="Icon" reason="Your private space keeps this icon.">
          <span className="bg-background inline-flex size-7 items-center justify-center rounded-lg">
            <Lock aria-hidden className="size-3.5" />
          </span>
        </SettingsRow>
        <SettingsRow label="Name" reason="Your private space keeps this name.">
          Private
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Who’s here"
        meta={`You and ${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`}
        testId="space-settings-members"
      >
        <div className="flex items-center gap-3 px-4 py-2.5">
          <span
            aria-hidden
            className="bg-background text-muted-foreground inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
          >
            You
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-medium">You</span>
            <span className="text-muted-foreground text-xs">
              Only you can be here. Nobody can be invited.
            </span>
          </div>
        </div>
        {agents.length > 0 && (
          <ul className="flex flex-col" aria-label="Your agents">
            {agents.map((agent) => (
              <li key={agent.id} className="flex items-center gap-3 py-2 pr-4 pl-14">
                <LetterTile letter={initialOf(agent.name)} color={tileColor(agent.id)} />
                <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                  <span className="truncate">{agent.name}</span>
                  <span className="bg-background text-muted-foreground shrink-0 rounded px-1.5 text-[11px] font-normal">
                    Agent
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      <LockedReason className="px-1 text-sm">
        Your private space can’t be left or deleted. It goes with your account.
      </LockedReason>
    </SettingsColumn>
  );
}
