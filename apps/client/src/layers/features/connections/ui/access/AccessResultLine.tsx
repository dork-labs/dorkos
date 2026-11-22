import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/layers/shared/ui';
import { accessResult, type AccessResultInput } from './access-result';
import { joinNames } from './access-labels';

/**
 * The page card's one line above Save: what saving now would do, said once
 * (DOR-4899). The region stays mounted so each new result is announced. A
 * shortened list ("Ada, Bo and 2 more") shows every name on hover or focus.
 *
 * @param props - The card's decision and the snapshot it was made against.
 */
export function AccessResultLine(props: AccessResultInput) {
  const result = accessResult(props);
  return (
    <div
      aria-live="polite"
      data-testid="access-result-line"
      className="text-foreground space-y-0.5 text-[13px]"
    >
      {result?.allNames ? (
        <TooltipProvider>
          <Tooltip>
            {/* A plain button, so a keyboard can reach the full list too. */}
            <TooltipTrigger className="w-fit rounded-sm text-left">{result.line}</TooltipTrigger>
            <TooltipContent>{joinNames(result.allNames)}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        result && <p>{result.line}</p>
      )}
      {result?.detail && <p>{result.detail}</p>}
    </div>
  );
}
