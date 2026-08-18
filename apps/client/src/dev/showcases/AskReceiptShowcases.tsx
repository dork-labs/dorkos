import { AskReceipt } from '@/layers/features/ask';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/**
 * When the showcased requests were asked for. Fixed rather than `Date.now()` so
 * the clock times on the page do not change between visits.
 */
const RECEIPT_ASKED_AT = new Date('2026-07-31T14:32:00Z').getTime();

/** The record an answered permission request leaves in the transcript. */
export function AskReceiptShowcases() {
  return (
    <PlaygroundSection
      title="AskReceipt"
      description="What an answered approval leaves behind — a one-line record at the ask's own place in the transcript. Quiet by design: it is meant to be findable later, not loud now."
    >
      <ShowcaseLabel>Allowed</ShowcaseLabel>
      <ShowcaseDemo>
        <AskReceipt
          outcome="allowed"
          items={[{ toolCallId: 'r-1', label: 'Run "npm test"' }]}
          startedAt={RECEIPT_ASKED_AT}
          resolvedAt={RECEIPT_ASKED_AT + 8_000}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Denied</ShowcaseLabel>
      <ShowcaseDemo>
        <AskReceipt
          outcome="denied"
          items={[{ toolCallId: 'r-2', label: 'Run "rm -rf build"' }]}
          startedAt={RECEIPT_ASKED_AT}
          resolvedAt={RECEIPT_ASKED_AT + 21_000}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Expired (nobody answered — auto-denied after the full timeout)</ShowcaseLabel>
      <ShowcaseDemo>
        <AskReceipt
          outcome="expired"
          items={[{ toolCallId: 'r-3', label: 'Write config.json' }]}
          startedAt={RECEIPT_ASKED_AT}
          resolvedAt={RECEIPT_ASKED_AT + 600_000}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Batch — one line, items behind the expander</ShowcaseLabel>
      <ShowcaseDemo>
        <AskReceipt
          outcome="allowed"
          items={[
            { toolCallId: 'r-4', label: 'Run "pnpm install"' },
            { toolCallId: 'r-5', label: 'Write vite.config.ts' },
            { toolCallId: 'r-6', label: 'Edit package.json' },
          ]}
          startedAt={RECEIPT_ASKED_AT}
          resolvedAt={RECEIPT_ASKED_AT + 12_000}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>No timestamp (a runtime that cannot say when)</ShowcaseLabel>
      <ShowcaseDemo>
        <AskReceipt outcome="allowed" items={[{ toolCallId: 'r-7', label: 'Read AGENTS.md' }]} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
