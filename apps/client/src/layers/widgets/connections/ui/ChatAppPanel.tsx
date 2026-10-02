import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { CatalogEntry, CatalogInstance } from '@dorkos/shared/relay-schemas';
import { useQueryClient } from '@tanstack/react-query';
import { UNCLAIMED_CHATS_QUERY_KEY } from '@/layers/entities/binding';
import { useRemoveAdapter, useToggleAdapter } from '@/layers/entities/relay';
import { ClaimFeed, PanelFix, PanelMoreRow, PanelSection } from '@/layers/features/connections';
import { AdapterSetupWizard, ChatAppAnswerers, ChatAppRecent } from '@/layers/features/relay';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/layers/shared/ui';

interface ChatAppPanelProps {
  /** The chat app's catalog entry (its manifest and every setup of it). */
  entry: CatalogEntry;
  /** The setup this panel is about. */
  instance: CatalogInstance;
  /** Close the panel (after the chat app is removed). */
  onClose: () => void;
}

/**
 * A chat app's side panel (design record §5, §9). It asks a different
 * question from an account: who answers when someone messages the bot. People
 * who reached the bot and wait for an OK sit right under it, then what
 * happened lately. Who may message the bot, group chats, the token and the
 * rest of its setup are under "More", in the setup wizard.
 */
export function ChatAppPanel({ entry, instance, onClose }: ChatAppPanelProps) {
  const { manifest } = entry;
  const toggle = useToggleAdapter();
  const remove = useRemoveAdapter();
  const queryClient = useQueryClient();
  const [wizard, setWizard] = useState<'edit' | 'add' | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const broken = instance.status.state === 'error' || instance.status.state === 'disconnected';
  const setEnabled = (enabled: boolean) => toggle.mutate({ id: instance.id, enabled });

  return (
    <div className="space-y-7">
      {!instance.enabled ? (
        <PanelFix
          message={'Paused. No messages go in or out.'}
          action="Resume"
          pending={toggle.isPending}
          onAction={() => setEnabled(true)}
        />
      ) : broken ? (
        <PanelFix
          // The bot's own error text (`status.lastError`) is written for
          // developers: the person reads one plain line and the one fix, and
          // the raw text waits under a collapsed "Details".
          message={'Stopped working. Messages aren’t getting through.'}
          technicalDetail={instance.status.lastError}
          action="Check its settings"
          onAction={() => setWizard('edit')}
        />
      ) : null}

      <PanelSection title="Who answers">
        <ChatAppAnswerers
          instance={instance}
          appName={manifest.displayName}
          emphasizePick={instance.enabled && !broken}
        />
      </PanelSection>

      <ClaimFeed enabled adapterId={instance.id} />

      <PanelSection title="Recently">
        <ChatAppRecent adapterId={instance.id} />
      </PanelSection>

      <Collapsible>
        <CollapsibleTrigger className="group/more text-muted-foreground hover:text-foreground focus-ring flex w-full items-center justify-between rounded-md py-1 text-sm font-semibold">
          More
          <ChevronRight
            className="size-4 transition-transform group-data-[state=open]/more:rotate-90"
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="-mx-2 space-y-1 pt-2" data-testid="app-panel-more">
          <PanelMoreRow
            label="Settings"
            hint="Who can message it, group chats, and its token"
            onClick={() => setWizard('edit')}
          />
          {instance.enabled ? (
            <PanelMoreRow
              label="Pause"
              hint="No messages in or out until you resume"
              disabled={toggle.isPending}
              onClick={() => setEnabled(false)}
            />
          ) : (
            <PanelMoreRow
              label="Resume"
              disabled={toggle.isPending}
              onClick={() => setEnabled(true)}
            />
          )}
          {manifest.multiInstance && (
            <PanelMoreRow
              label={`Set up another ${manifest.displayName}`}
              onClick={() => setWizard('add')}
            />
          )}
          <PanelMoreRow label="Remove…" destructive onClick={() => setConfirmRemove(true)} />
        </CollapsibleContent>
      </Collapsible>

      {wizard && (
        <AdapterSetupWizard
          open
          onOpenChange={(open) => {
            if (!open) setWizard(null);
          }}
          manifest={manifest}
          existingInstance={wizard === 'edit' ? instance : undefined}
          existingAdapterIds={entry.instances.map((candidate) => candidate.id)}
        />
      )}

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {manifest.displayName}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>It stops working and its settings are deleted.</p>
                <p>So are its recent deliveries and everyone waiting, ignored or blocked.</p>
                <p>Messages sent to it after that reach nobody.</p>
                <p>If you set it up again, block those people again.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90 dark:bg-destructive/60 text-white"
              onClick={() => {
                remove.mutate(instance.id, {
                  onSuccess: () => {
                    // The server deleted this connection's waiting chats too
                    // (DOR-2608), and sends no event for it. Refetch, so a
                    // connection set up again under the same id starts empty.
                    void queryClient.invalidateQueries({
                      queryKey: [...UNCLAIMED_CHATS_QUERY_KEY],
                    });
                    onClose();
                  },
                });
              }}
            >
              Remove {manifest.displayName}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
