/**
 * The Inbox card for an app update, drawn with the real `ExtensionApprovalList`
 * and made-up apps: one update that adds powers, each marked new, and one
 * that only changed files (DOR-4504).
 *
 * @module dev/showcases/ExtensionUpdateShowcases
 */
import type { PendingExtensionApproval } from '@dorkos/shared/extension-approval-schemas';
import { ExtensionApprovalList } from '@/layers/widgets/inbox-bell';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** A made-up app the person allowed at 1.0.0, now updated to 1.1.0. */
const NOTES_UPDATE: PendingExtensionApproval = {
  id: 'sample-notes',
  name: 'Notes',
  version: '1.1.0',
  path: '/home/sample/.dork/extensions/sample-notes',
  plugin: null,
  sourceLabel: 'added directly',
  runsInServer: true,
  adds: 'It adds a Notes tab',
  since: '2026-11-15T12:00:00.000Z',
  why: 'Notes was updated from 1.0.0 to 1.1.0: extension.json. It runs as you.',
  permissions: {
    runtime: 'subprocess',
    net: ['api.notes.example.com', 'sync.notes.example.com'],
    run: [
      { name: 'git', found: true },
      { name: 'rg', found: true },
    ],
    agents: true,
    hasPage: true,
    apps: [{ id: 'sample-planner', name: 'Planner', access: null, opens: true }],
  },
  added: {
    net: ['sync.notes.example.com'],
    run: ['rg'],
    agents: true,
    runtime: false,
    apps: ['sample-planner'],
  },
  agentTools: [],
  agentSkills: [],
  digest: null,
  changedFiles: ['extension.json'],
  updatedFrom: '1.0.0',
};

/** The same update with no new power: its files changed, nothing more. */
const FILES_ONLY: PendingExtensionApproval = {
  ...NOTES_UPDATE,
  id: 'sample-tasks',
  name: 'Tasks',
  path: '/home/sample/.dork/extensions/sample-tasks',
  why: 'Tasks was updated from 1.0.0 to 1.1.0: index.ts. It runs as you.',
  added: null,
  changedFiles: ['index.ts'],
};

/** An app update in the Inbox: one that adds powers, and one that adds none. */
export function ExtensionUpdateShowcases() {
  return (
    <PlaygroundSection
      title="Extension update card"
      description="An app update waits for a yes. Each power it adds is listed as new; an update that only changed files lists none."
    >
      <ShowcaseLabel>
        An update that adds a host, a program, agent access and opening Planner
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div
          data-testid="extension-update-adds"
          className="border-border/60 bg-background/60 w-[min(30rem,100%)] rounded-lg border p-2"
        >
          <ExtensionApprovalList approvals={[NOTES_UPDATE]} onOpenSettings={() => {}} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>An update that only changed files</ShowcaseLabel>
      <ShowcaseDemo>
        <div
          data-testid="extension-update-files-only"
          className="border-border/60 bg-background/60 w-[min(30rem,100%)] rounded-lg border p-2"
        >
          <ExtensionApprovalList approvals={[FILES_ONLY]} onOpenSettings={() => {}} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
