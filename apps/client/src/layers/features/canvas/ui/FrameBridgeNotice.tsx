import { FRAME_SCRIPT_HTML_MAX_BYTES, type FrameBridgeRefusal } from '@dorkos/shared/schemas';

const MAX_MB = FRAME_SCRIPT_HTML_MAX_BYTES / (1024 * 1024);

/** One line per refusal code, for the person looking at the page. */
const REFUSAL_COPY: Record<FrameBridgeRefusal, string> = {
  csp: 'This page’s security policy blocks added scripts, so it can’t talk to its agent.',
  encoding: 'This page isn’t saved as UTF-8, so it can’t talk to its agent.',
  oversize: `This page is over ${MAX_MB} MB, so it can’t talk to its agent.`,
  'no-head': 'This page has no <head> tag, so it can’t talk to its agent.',
  markup: 'DorkOS can’t safely read this page’s <head>, so it can’t talk to its agent.',
  'fixed-source': 'DorkOS couldn’t connect this page to its agent.',
};

/**
 * The line above a framed page that says why DorkOS could not connect it to its
 * agent (DOR-3131). Never silent: every refusal code has its own sentence.
 *
 * @param props.reason - The stable refusal code the server recorded.
 */
export function FrameBridgeNotice({ reason }: { reason: FrameBridgeRefusal }) {
  return (
    <p
      role="status"
      data-bridge-refusal={reason}
      className="text-muted-foreground border-border/60 border-b px-2 py-1 text-xs"
    >
      {REFUSAL_COPY[reason]}
    </p>
  );
}
