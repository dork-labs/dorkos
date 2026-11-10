import { useState } from 'react';
import { Button } from '@/layers/shared/ui';

/** What an author changes to move an app to extension API version 2 (DOR-3293). */
const EXTENSION_UPDATE_GUIDE_URL = 'https://dorkos.ai/docs/integrations/extension-frame-migration';

/** A failed app's Settings section keeps its name and one way to retry. */
export function ExtensionLoadFailure({
  retry,
  needsUpdate = false,
}: {
  retry: () => Promise<unknown>;
  /** The app was built for an older extension API and cannot load until rebuilt. */
  needsUpdate?: boolean;
}) {
  const [trying, setTrying] = useState(false);
  if (needsUpdate) {
    return (
      <div className="space-y-2">
        <p className="text-muted-foreground text-sm">
          This app needs an update for this version of DorkOS.
        </p>
        <a
          className="text-sm underline"
          href={EXTENSION_UPDATE_GUIDE_URL}
          target="_blank"
          rel="noreferrer"
        >
          How to update it
        </a>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3">
      <p className="text-muted-foreground text-sm">Not working</p>
      <Button
        variant="outline"
        size="sm"
        disabled={trying}
        onClick={async () => {
          setTrying(true);
          try {
            await retry();
          } catch (error) {
            console.error('[extensions] Retry could not read the app list:', error);
          } finally {
            setTrying(false);
          }
        }}
      >
        {trying ? 'Trying…' : 'Try again'}
      </Button>
    </div>
  );
}
