import { DorkLogo } from '@dorkos/icons/logos';
import { Button } from '@/layers/shared/ui';
import { useConfig } from '@/layers/entities/config';

/**
 * How often the screen re-asks the server while it is up.
 *
 * Slow on purpose: the thing it is waiting for is a server that is starting,
 * which takes seconds, and a tight poll would only make a struggling machine
 * work harder. TanStack owns the loop — this is `refetchInterval` on the SAME
 * config query the shell reads, so a success lands in the one cache entry every
 * other reader shares and this screen disappears with it. Nothing here keeps a
 * second copy of "is the server up".
 */
const RETRY_INTERVAL_MS = 5000;

/**
 * The whole window, when `GET /api/config` will not answer.
 *
 * The bundle loaded and React mounted — the inline boot sentinel in
 * `index.html` is right to stay quiet — but the data layer has nothing, so the
 * shell has no honest app to draw. What it drew instead was
 * `<div class="bg-background h-dvh" />`: a black rectangle indistinguishable
 * from the v0.63.0 crash, and after the shell's 3s escape hatch, a first-run
 * overlay that cannot save a single answer it collects (DOR-1475).
 *
 * The copy stays surface-neutral. In the desktop app the server is a child
 * process of the window showing this screen, so "check your network" would be
 * wrong there — and it is the same screen in both places. "It may still be
 * starting up" is true of every surface DorkOS ships.
 *
 * **No raw error text here, deliberately** — the settings pane's smaller
 * unreachable notice does show it, and this screen does not. TanStack clears a
 * dataless query's error the instant the next attempt starts, so a line printed
 * from it would blink off the page every time this screen does the retrying it
 * promises. Latching it back would be a workaround for a value that says
 * "Failed to fetch" to a person whose only useful move is the button below. The
 * reason is not lost: the query cache logs every failure to the console, and
 * the boot sentinel owns the copyable diagnostics for the failure one step
 * earlier.
 */
export function ServerUnreachableScreen() {
  const { isFetching, refetch } = useConfig({ refetchInterval: RETRY_INTERVAL_MS });

  return (
    <div
      data-testid="server-unreachable"
      className="bg-background text-foreground flex h-dvh flex-col items-center justify-center px-6"
    >
      <div className="flex w-full max-w-md flex-col items-center text-center">
        {/* The light/dark pair, as everywhere else the wordmark appears — the
            logo is a fixed-colour SVG, not a `currentColor` glyph. */}
        <DorkLogo size={120} className="mb-8 opacity-80 dark:hidden" />
        <DorkLogo variant="white" size={120} className="mb-8 hidden opacity-80 dark:block" />
        <h1 className="text-xl font-semibold tracking-tight">
          DorkOS can&rsquo;t reach its server.
        </h1>
        <p className="text-muted-foreground mt-3 text-sm">
          It may still be starting up. DorkOS keeps checking, and this screen clears as soon as the
          server answers.
        </p>
        {/* No `aria-label` here: the visible words ARE the accessible name, and
            an override that does not contain them breaks speech control, where
            "click Try again" has to match what the user can read (WCAG 2.5.3). */}
        <Button
          variant="outline"
          className="mt-6"
          onClick={() => void refetch()}
          disabled={isFetching}
        >
          {isFetching ? 'Trying…' : 'Try again'}
        </Button>
      </div>
    </div>
  );
}
