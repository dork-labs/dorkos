'use client';

import { useCallback, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';

/** How long the copied checkmark stays visible before reverting. */
const COPIED_RESET_MS = 2000;

/** Brand orange for the `$` prompt; matches the marketing terminal mockups. */
const PROMPT_COLOR = '#E85D04';

/** Confirmation green for the copied checkmark. */
const COPIED_COLOR = '#228B22';

interface CommandChipProps {
  /** The shell command to display and copy (rendered after a `$ ` prompt). */
  command: string;
  /** Called after the command has successfully landed on the clipboard. */
  onCopied?: () => void;
  /** Optional extra classes on the root. */
  className?: string;
}

/**
 * A refined, copyable terminal-command chip — a one-line command offered
 * quietly, not as a form field. Borderless save for a whisper of warm tint,
 * an orange `$` prompt echoing the marketing terminal mockups, and a copy
 * glyph that stays subtle until hover/focus. Always copies the real command
 * with check confirmation; long commands scroll within the chip rather than
 * overflowing on mobile.
 *
 * @param props - Command text, optional copy callback, optional className.
 */
export function CommandChip({ command, onCopied, className }: CommandChipProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    // Only confirm once the write lands — insecure contexts reject.
    navigator.clipboard.writeText(command).then(
      () => {
        onCopied?.();
        setCopied(true);
        setTimeout(() => setCopied(false), COPIED_RESET_MS);
      },
      () => {}
    );
  }, [command, onCopied]);

  return (
    <div
      className={cn(
        'group inline-flex max-w-full items-center gap-3 rounded-lg bg-[rgba(139,90,43,0.05)] px-4 py-2.5',
        className
      )}
    >
      {/* bg-transparent/p-0 neutralize the global `code` chip styling from globals.css */}
      <code className="text-charcoal min-w-0 overflow-x-auto rounded-none bg-transparent p-0 font-mono text-[13px] whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <span style={{ color: PROMPT_COLOR }}>$ </span>
        {command}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? 'Command copied' : `Copy command: ${command}`}
        className="text-warm-gray-light hover:text-brand-orange focus-visible:ring-brand-orange/40 shrink-0 rounded p-1 opacity-70 transition-all group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none"
      >
        {copied ? (
          <Check size={13} style={{ color: COPIED_COLOR }} />
        ) : (
          <Copy size={13} aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
