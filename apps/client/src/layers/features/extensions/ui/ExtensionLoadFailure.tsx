import { useState } from 'react';
import { Button } from '@/layers/shared/ui';

/** A failed app's Settings section keeps its name and one way to retry. */
export function ExtensionLoadFailure({ retry }: { retry: () => Promise<unknown> }) {
  const [trying, setTrying] = useState(false);
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
