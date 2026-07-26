import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { SessionReadout } from '@/layers/features/status';
import { SESSION_DIAGNOSTICS } from '../mock-samples';

/**
 * The right panel's Session tab — the roomier counterpart to the status line's
 * `⋯` panel. Rendered here as the real component against mock snapshots, so a
 * layout change in the app shows up here without being copied.
 */
export function SessionInspectorShowcases() {
  return (
    <PlaygroundSection
      title="SessionInspector"
      description="The right panel's Session readout: stream health, resolved settings, usage, and subagents. Shows everything always — you opened it on purpose."
    >
      <ShowcaseLabel>Healthy — streaming, cache warm, one subagent running</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="h-[560px] w-full max-w-sm border">
          <SessionReadout diagnostics={SESSION_DIAGNOSTICS.healthy} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Degraded — reconnecting, stream silent, messages queued</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="h-[560px] w-full max-w-sm border">
          <SessionReadout diagnostics={SESSION_DIAGNOSTICS.degraded} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Cold — nothing has hydrated yet</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="h-[560px] w-full max-w-sm border">
          <SessionReadout diagnostics={SESSION_DIAGNOSTICS.cold} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
