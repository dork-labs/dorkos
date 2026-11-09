import { useEffect, useState } from 'react';
import { useAppActions, useAppTrying } from '@/layers/entities/extension';
import { Button, PageContainer } from '@/layers/shared/ui';

/**
 * How long a load runs before "Starting…" shows. An app that loads faster
 * shows nothing before its page, so a quick load never flashes a status line.
 */
export const STARTING_LINE_DELAY_MS = 300;

/**
 * The page body while its app loads: nothing at first, then one quiet
 * "Starting…" line at the top left. The bar above already names the app.
 *
 * @param quiet - Never say "Starting…": the wait only holds back an answer
 *   that is already known, so a missing page does not flash a status first.
 */
export function ExtensionPageStarting({ quiet = false }: { quiet?: boolean }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (quiet) return;
    const timer = setTimeout(() => setShow(true), STARTING_LINE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [quiet]);

  return (
    <PageContainer width="wide">
      <div data-testid="extension-page-loading" aria-busy="true">
        {show && !quiet && <p className="text-muted-foreground text-sm">Starting…</p>}
      </div>
    </PageContainer>
  );
}

/**
 * The page body when its app never finished loading in this window. Try again
 * runs the same retry as the app's tile, which checks it may still run.
 *
 * @param id - The app's extension id.
 * @param name - The app's name.
 */
export function ExtensionPageNotWorking({ id, name }: { id: string; name: string }) {
  const { tryAgain } = useAppActions();
  const trying = useAppTrying(id);

  return (
    <PageContainer width="wide">
      <div data-testid="extension-page-not-working" className="flex flex-col items-start gap-3">
        <p className="text-sm">{`${name} isn’t working.`}</p>
        <Button variant="outline" size="sm" disabled={trying} onClick={() => void tryAgain(id)}>
          {trying ? 'Trying…' : 'Try again'}
        </Button>
      </div>
    </PageContainer>
  );
}
