import { useState } from 'react';
import { AlertTriangle, XCircle, Puzzle, ChevronDown } from 'lucide-react';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import { Badge, Switch } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

interface ExtensionCardProps {
  /** The extension record from the server. */
  extension: ExtensionRecordPublic;
  /** Called when the enable/disable toggle changes. */
  onToggle: (id: string, enabled: boolean) => void;
  /** Whether an API call for this extension is in progress. */
  isToggling: boolean;
}

const TERMINAL_STATUSES = new Set(['disabled', 'discovered', 'incompatible', 'invalid']);

/** Per-extension card in the Extensions settings tab. */
export function ExtensionCard({ extension, onToggle, isToggling }: ExtensionCardProps) {
  const { manifest, status, scope, error } = extension;
  const [errorExpanded, setErrorExpanded] = useState(false);

  const isEnabled = !TERMINAL_STATUSES.has(status);
  const isIncompatible = status === 'incompatible';
  const isInvalid = status === 'invalid';
  const hasError = status === 'compile_error' || status === 'activate_error';
  const canToggle = !isIncompatible && !isInvalid;

  return (
    <div
      data-slot="extension-card"
      data-testid={`extension-card-${extension.id}`}
      className={cn(
        'bg-card rounded-xl border p-4',
        hasError && 'border-amber-500/50',
        (isIncompatible || isInvalid) && 'opacity-70'
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          {/* Name row */}
          <div className="flex flex-wrap items-center gap-2">
            {hasError && (
              <AlertTriangle className="size-4 shrink-0 text-amber-500" aria-hidden="true" />
            )}
            {(isIncompatible || isInvalid) && !hasError && (
              <XCircle className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
            )}
            {!hasError && !isIncompatible && !isInvalid && (
              <Puzzle className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
            )}

            <span className="font-medium">{manifest.name}</span>
            <span className="text-muted-foreground text-sm">v{manifest.version}</span>
          </div>

          {/* Description */}
          {manifest.description && (
            <p className="text-muted-foreground text-sm">{manifest.description}</p>
          )}

          {/* Incompatible message */}
          {isIncompatible && manifest.minHostVersion && (
            <p className="text-muted-foreground text-sm">
              Requires DorkOS &gt;= {manifest.minHostVersion}
            </p>
          )}

          {/* Error summary with expandable details */}
          {hasError && error && (
            <div className="space-y-1">
              <p className="text-sm text-amber-600 dark:text-amber-400">
                {status === 'compile_error' ? 'Compilation error: ' : 'Activation failed: '}
                {error.message}
              </p>
              {error.details && (
                <button
                  type="button"
                  onClick={() => setErrorExpanded((v) => !v)}
                  className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
                  aria-expanded={errorExpanded}
                >
                  <ChevronDown
                    className={cn('size-3 transition-transform', errorExpanded && 'rotate-180')}
                  />
                  {errorExpanded ? 'Hide details' : 'Show details'}
                </button>
              )}
              {errorExpanded && error.details && (
                <pre className="bg-muted mt-1 max-h-32 overflow-auto rounded-md p-2 text-xs">
                  {error.details}
                </pre>
              )}
            </div>
          )}

          {/* Metadata row */}
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline" className="text-xs">
              {scope}
            </Badge>
            {manifest.author && <span>{manifest.author}</span>}
          </div>
        </div>

        {/* Enable/disable toggle */}
        <div className="pt-0.5">
          <Switch
            checked={isEnabled}
            onCheckedChange={(checked) => onToggle(extension.id, checked)}
            disabled={!canToggle || isToggling}
            aria-label={`${isEnabled ? 'Disable' : 'Enable'} ${manifest.name}`}
          />
        </div>
      </div>
    </div>
  );
}
