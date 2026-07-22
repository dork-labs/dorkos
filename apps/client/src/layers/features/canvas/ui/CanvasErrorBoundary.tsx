import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
import { Button } from '@/layers/shared/ui';

/**
 * A caught error whose message matches a rejected `React.lazy` dynamic import —
 * the shape a stale viewer chunk takes after the app was rebuilt or redeployed
 * while a tab stayed open. Reloading fetches the current chunk hashes.
 */
const DYNAMIC_IMPORT_ERROR =
  /dynamically imported module|Loading chunk|Importing a module script failed|ChunkLoadError/i;

/** Whether a caught error looks like a failed dynamic import of a viewer chunk. */
function isDynamicImportError(error: Error): boolean {
  return DYNAMIC_IMPORT_ERROR.test(error.message);
}

/** The in-tab message shown when a document's viewer fails to render. */
function CanvasErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }): ReactNode {
  const staleChunk = isDynamicImportError(error);
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <p>This tab hit a problem.</p>
      {staleChunk && (
        <p className="text-sm">
          The app may have updated since you opened this tab. Reloading usually fixes it.
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RotateCw className="size-4" />
          Retry
        </Button>
        {staleChunk && (
          <Button type="button" size="sm" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        )}
      </div>
    </div>
  );
}

interface CanvasErrorBoundaryProps {
  /**
   * Id of the active canvas document. Used to label the error log; the parent
   * also keys this boundary by it, so switching tabs mounts a fresh boundary and
   * clears any error, and switching back re-attempts the render.
   */
  documentId: string;
  children: ReactNode;
}

interface CanvasErrorBoundaryState {
  error: Error | null;
  /** Bumped by Retry to remount the wrapped renderer without switching tabs. */
  retryKey: number;
}

/**
 * Per-document error boundary for the canvas body.
 *
 * Wraps only the active document's renderer, so a viewer that throws — a failed
 * `React.lazy` chunk import after a rebuild, a WebGL failure, a bad file — is
 * contained to that one tab. The tab strip, tab switching, and every other open
 * document keep working. The fallback offers Retry (remounts the viewer) and,
 * for a stale-chunk import failure, a Reload app affordance. The outer
 * `PanelErrorBoundary` stays as the last-resort net.
 */
export class CanvasErrorBoundary extends Component<
  CanvasErrorBoundaryProps,
  CanvasErrorBoundaryState
> {
  state: CanvasErrorBoundaryState = { error: null, retryKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<CanvasErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[Canvas] Document viewer error (${this.props.documentId}):`, error, info);
  }

  private handleRetry = (): void => {
    this.setState((s) => ({ error: null, retryKey: s.retryKey + 1 }));
  };

  render(): ReactNode {
    const { error, retryKey } = this.state;
    if (error) {
      return <CanvasErrorFallback error={error} onRetry={this.handleRetry} />;
    }
    // Keyed so Retry unmounts and remounts the renderer fresh, re-attempting the
    // viewer (and any lazy chunk) instead of re-rendering the failed instance.
    return <Fragment key={retryKey}>{this.props.children}</Fragment>;
  }
}
