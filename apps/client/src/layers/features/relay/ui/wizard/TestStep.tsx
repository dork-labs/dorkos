import { Loader2, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { Button } from '@/layers/shared/ui/button';

interface TestStepProps {
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  errorMessage?: string;
  botUsername?: string;
  onRetry: () => void;
}

/** Connection test step showing pending/success/error state. */
export function TestStep({
  isPending,
  isSuccess,
  isError,
  errorMessage,
  botUsername,
  onRetry,
}: TestStepProps) {
  return (
    <div className="flex flex-col items-center gap-3 py-6">
      {isPending && (
        <>
          <Loader2 className="text-muted-foreground size-8 animate-spin" />
          <p className="text-muted-foreground text-sm">Testing connection...</p>
        </>
      )}
      {isSuccess && (
        <div className="flex flex-col items-center gap-2">
          <CheckCircle2 className="size-8 text-green-500" />
          <p className="text-sm text-green-700 dark:text-green-400">Connection successful</p>
          {botUsername && (
            <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <span className="font-mono">@{botUsername}</span>
            </div>
          )}
        </div>
      )}
      {isError && (
        <>
          <XCircle className="size-8 text-red-500" />
          <p className="text-sm text-red-700 dark:text-red-400">Connection failed</p>
          {errorMessage && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </>
      )}
    </div>
  );
}
