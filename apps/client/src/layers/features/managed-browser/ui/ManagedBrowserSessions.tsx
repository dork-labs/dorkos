import { useRef, useState } from 'react';
import { Button } from '@/layers/shared/ui';
import {
  useBrowserInstances,
  useBrowserProfiles,
  useCloseBrowserInstance,
  type BrowserInstance,
} from '@/layers/entities/browser';

/** Cache and selection scope only; the server authenticates every operation. */
export interface ManagedBrowserSessionsProps {
  readonly owner: string;
  readonly onSelect: (instance: BrowserInstance) => void;
  readonly onClosing?: (instance: BrowserInstance) => void;
  readonly disabled?: boolean;
  readonly selectionDisabled?: boolean;
}

/** Owner-scoped live browser selection, with truthful original cleanup receipts. */
export function ManagedBrowserSessions(props: ManagedBrowserSessionsProps) {
  return <OwnerBrowserSessions key={props.owner} {...props} />;
}

/** A fresh local UI lifetime is created for every authenticated cache owner. */
function OwnerBrowserSessions({
  owner,
  onSelect,
  onClosing,
  disabled = false,
  selectionDisabled = false,
}: ManagedBrowserSessionsProps) {
  const instances = useBrowserInstances(owner);
  const profiles = useBrowserProfiles(owner);
  const close = useCloseBrowserInstance(owner);
  const activeClose = useRef(false);
  const [closing, setClosing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const profileLabels = new Map(
    profiles.data?.map((profile) => [profile.profileId, profile.label])
  );

  async function closeOriginal(instance: BrowserInstance) {
    if (activeClose.current || disabled) return;
    activeClose.current = true;
    const key = `${instance.browserId}:${instance.browserGeneration}`;
    setClosing(key);
    setNotice(null);
    try {
      onClosing?.(instance);
      const receipt = await close.mutateAsync({
        requestId: crypto.randomUUID(),
        browserId: instance.browserId,
        browserGeneration: instance.browserGeneration,
      });
      setNotice(
        receipt.cleanup === 'observed'
          ? 'Browser closed.'
          : 'The browser may still be running. Its cleanup could not be confirmed.'
      );
    } catch {
      setNotice('The browser could not be closed. Refresh the list before trying again.');
    } finally {
      activeClose.current = false;
      setClosing(null);
    }
  }

  return (
    <section aria-label="Your browsers" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Your browsers</h2>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || instances.isFetching}
          onClick={() => void instances.refetch()}
        >
          Refresh
        </Button>
      </div>
      {instances.isPending ? <p role="status">Loading browsers…</p> : null}
      {instances.isError ? (
        <p role="alert">Your browsers could not be loaded. Try refreshing the list.</p>
      ) : null}
      {notice ? (
        <p role="status" className="text-muted-foreground text-sm">
          {notice}
        </p>
      ) : null}
      {instances.isSuccess && instances.data.length === 0 ? (
        <p className="text-muted-foreground text-sm">No browsers are open.</p>
      ) : null}
      <ul className="space-y-1">
        {(instances.isSuccess ? instances.data : []).map((instance, index) => {
          const key = `${instance.browserId}:${instance.browserGeneration}`;
          const label =
            instance.mode === 'persistent'
              ? (profileLabels.get(instance.profileId) ?? 'Saved browser')
              : `Clean browser ${index + 1}`;
          return (
            <li key={key} className="bg-muted/40 flex flex-wrap items-center gap-2 rounded-md p-2">
              <span className="min-w-0 flex-1 text-sm">{label}</span>
              <span className="text-muted-foreground text-xs">
                {instance.status === 'uncertain' ? 'Could not confirm' : instance.status}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={
                  disabled || selectionDisabled || instance.status !== 'running' || closing !== null
                }
                onClick={() => onSelect(instance)}
              >
                View
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || instance.status === 'stopped' || closing !== null}
                onClick={() => void closeOriginal(instance)}
              >
                {closing === key ? 'Closing…' : 'Close'}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
