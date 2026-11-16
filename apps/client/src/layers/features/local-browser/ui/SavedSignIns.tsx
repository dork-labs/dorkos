import { useRef, useState } from 'react';
import { Button } from '@/layers/shared/ui';
import { ForgetSignInsDialog } from './ForgetSignInsDialog';

/**
 * The Agent browser's saved sign-ins, as one row with a confirmed Forget (DOR-4105),
 * while no page is open. With a page open, Forget lives in the browser's ⋯ menu.
 */
export function SavedSignIns({
  enabled,
  disabled = false,
}: {
  enabled: boolean;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState('');
  const opener = useRef<HTMLButtonElement | null>(null);
  if (!enabled) return null;
  return (
    <section aria-label="Saved sign-ins" className="flex shrink-0 items-center gap-3">
      <div className="min-w-0 flex-1">
        <h4 className="text-sm font-medium">Saved sign-ins</h4>
        <p className="text-muted-foreground text-xs">
          Kept apart from your own browser. Every agent here shares them.
        </p>
        {disabled && (
          <p className="text-muted-foreground text-xs">Wait for the browser action to finish.</p>
        )}
      </div>
      <Button
        ref={opener}
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => {
          setNotice('');
          setAsking(true);
        }}
      >
        Forget…
      </Button>
      <p role="status" className="sr-only">
        {notice}
      </p>
      <ForgetSignInsDialog
        open={asking}
        onOpenChange={setAsking}
        returnFocus={opener}
        onForgotten={() => setNotice('Sign-ins forgotten.')}
      />
    </section>
  );
}
