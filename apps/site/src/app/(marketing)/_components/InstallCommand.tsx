'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { INSTALL_COMMAND } from './theme';

const COPY_RESET_MS = 2000;

const VARIANTS = {
  /** Standalone pill, for when the command is the main action. */
  solid:
    'gap-3 rounded-full border border-(--line) bg-(--panel) py-3 pr-5 pl-6 text-sm hover:border-[rgba(232,93,4,0.5)] sm:text-base',
  /** Quiet inline form, for when it sits under the Mac download button. */
  quiet: 'gap-2 rounded-lg px-2 py-1 text-xs hover:bg-(--panel) sm:text-sm',
} as const;

/** The install command as a click-to-copy control. */
export function InstallCommand({ variant = 'solid' }: { variant?: keyof typeof VARIANTS }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(INSTALL_COMMAND);
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_RESET_MS);
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy install command: ${INSTALL_COMMAND}`}
      className={`group inline-flex items-center font-mono text-(--cream) transition-colors focus-visible:ring-2 focus-visible:ring-(--ember) focus-visible:outline-none ${VARIANTS[variant]}`}
    >
      <span className="text-(--ember)" aria-hidden="true">
        $
      </span>
      {INSTALL_COMMAND}
      {copied ? (
        <Check size={14} className="text-[#4cc38a]" aria-hidden="true" />
      ) : (
        <Copy
          size={14}
          className="text-(--cream-dim) transition-colors group-hover:text-(--cream)"
          aria-hidden="true"
        />
      )}
    </button>
  );
}
