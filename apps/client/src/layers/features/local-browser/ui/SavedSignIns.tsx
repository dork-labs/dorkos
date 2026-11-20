import { useRef, useState } from 'react';
import { Button } from '@/layers/shared/ui';
import { ForgetSignInsDialog } from './ForgetSignInsDialog';

/**
 * Forget saved sign-ins (DOR-4105) while no page is open: one quiet link at the
 * foot of the page-area block, opening the same confirm as the ⋯ menu's item.
 * With a page open, Forget lives in that menu instead.
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
    <div className="pt-2">
      <Button
        ref={opener}
        size="sm"
        variant="link"
        className="text-muted-foreground h-auto p-0 md:h-auto"
        disabled={disabled}
        onClick={() => {
          setNotice('');
          setAsking(true);
        }}
      >
        Forget saved sign-ins…
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
    </div>
  );
}
