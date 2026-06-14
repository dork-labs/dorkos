import { Terminal } from 'lucide-react';
import { OutputRenderer } from './OutputRenderer';

/**
 * A complete output block for a local in-process slash command (`/context`,
 * `/usage`, `/cost`). Renders the captured stdout through the shared
 * {@link OutputRenderer} (ANSI / JSON / plain text with truncation). The local
 * command's name is not carried on the event, so the header is the generic
 * "Command output". Live-only — this block is intentionally ephemeral and does
 * not survive a history reload.
 */
export function LocalCommandOutputBlock({ content }: { content: string }) {
  return (
    <div
      data-testid="local-command-output"
      className="bg-muted/50 rounded-msg-tool shadow-msg-tool my-1 border px-3 py-2"
    >
      <div className="text-muted-foreground/60 mb-1 flex items-center gap-1.5 text-xs">
        <Terminal aria-hidden="true" className="size-3 shrink-0" />
        <span className="font-mono">Command output</span>
      </div>
      <OutputRenderer content={content} toolName="" />
    </div>
  );
}
