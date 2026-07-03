import { Terminal, ExternalLink } from 'lucide-react';
import { CopyButton } from '@/layers/shared/ui';

interface DependencyInstallHintProps {
  /** Copyable install/auth shell command. Omit to render only the docs link. */
  command?: string;
  /** Optional docs link rendered below the command. */
  infoUrl?: string;
  /** Accessible name for the copy button. Defaults to "Copy install command". */
  copyLabel?: string;
}

/**
 * A copyable install/auth command with an optional "Learn more" link.
 *
 * The shared guidance block for unsatisfied runtime dependencies — rendered by
 * the onboarding requirements step and the runtime setup panel so install
 * instructions look and behave identically everywhere. Renders nothing when
 * a dependency carries neither a command nor a docs link.
 */
export function DependencyInstallHint({ command, infoUrl, copyLabel }: DependencyInstallHintProps) {
  if (!command && !infoUrl) return null;
  return (
    <div className="space-y-2">
      {command && (
        <div className="bg-muted flex items-center justify-between gap-2 rounded-lg px-3 py-2.5">
          <div className="flex items-center gap-2 overflow-hidden">
            <Terminal className="text-muted-foreground size-3.5 shrink-0" />
            <code className="truncate text-xs">{command}</code>
          </div>
          <CopyButton
            value={command}
            label={copyLabel ?? 'Copy install command'}
            className="shrink-0"
          />
        </div>
      )}
      {infoUrl && (
        <a
          href={infoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
        >
          Learn more <ExternalLink className="size-3" />
        </a>
      )}
    </div>
  );
}
