import { useState, type ReactNode } from 'react';
import { Button } from '@/layers/shared/ui';
import { BrowserLoadingBar, PageErrorBlock, pageErrorBlock } from '@/layers/features/local-browser';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** Every failure the page area draws, on a made-up host (DOR-4430). */
const FAILURES: Array<{ label: string; code: string; typed?: boolean }> = [
  { label: 'Name not found, typed by you', code: 'ERR_NAME_NOT_RESOLVED', typed: true },
  { label: 'Name not found, an agent’s address', code: 'ERR_NAME_NOT_RESOLVED' },
  { label: 'Refused, reset or timed out', code: 'ERR_CONNECTION_REFUSED' },
  { label: 'Offline', code: 'ERR_INTERNET_DISCONNECTED' },
  { label: 'Certificate', code: 'ERR_CERT_AUTHORITY_INVALID' },
  { label: 'Blocked by DorkOS', code: 'ERR_BLOCKED_BY_CLIENT' },
  { label: 'Blocked by policy', code: 'ERR_BLOCKED_BY_ADMINISTRATOR' },
  { label: 'Too many redirects', code: 'ERR_TOO_MANY_REDIRECTS' },
  { label: 'Page crashed', code: 'CRASHED' },
];

/** The page area as the panel draws it: the seam, then the page, edge to edge. */
function PageArea({ loading = false, children }: { loading?: boolean; children?: ReactNode }) {
  return (
    <div className="bg-background flex h-72 w-full max-w-sm flex-col rounded-lg border">
      <div className="text-muted-foreground flex h-9 shrink-0 items-center px-2.5 text-xs">
        northwind.example/pricing
      </div>
      <BrowserLoadingBar loading={loading} />
      <div className="bg-muted/20 relative flex-1">
        <div className="absolute inset-0 flex overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

/** A load you start and finish, to watch the bar run, complete and fade. */
function LoadingDemo() {
  const [loading, setLoading] = useState(false);
  return (
    <div className="flex flex-col items-start gap-3">
      <PageArea loading={loading} />
      <Button size="sm" variant="outline" onClick={() => setLoading((now) => !now)}>
        {loading ? 'Finish the load' : 'Start a load'}
      </Button>
    </div>
  );
}

/** The Agent browser's own error blocks and its loading line (DOR-4430, DOR-4431). */
export function BrowserPageErrorShowcases() {
  return (
    <PlaygroundSection
      title="Agent browser page errors and loading"
      description="What the page area shows when a page fails to load, and the 2px line while one loads."
    >
      <ShowcaseLabel>Loading: no spinner, a line in the seam</ShowcaseLabel>
      <ShowcaseDemo>
        <LoadingDemo />
      </ShowcaseDemo>
      {FAILURES.map(({ label, code, typed = false }) => {
        const block = pageErrorBlock({ code, host: 'northwind.example' }, typed);
        return (
          <div key={label}>
            <ShowcaseLabel>{label}</ShowcaseLabel>
            <ShowcaseDemo>
              <PageArea>{block && <PageErrorBlock block={block} onAction={() => {}} />}</PageArea>
            </ShowcaseDemo>
          </div>
        );
      })}
    </PlaygroundSection>
  );
}
