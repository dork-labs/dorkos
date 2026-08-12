import { Component } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface Props {
  children: React.ReactNode;
  /** Optional label to identify which showcase crashed. */
  name?: string;
}

interface State {
  error: Error | null;
}

/**
 * Error boundary for individual playground showcases.
 *
 * Catches render errors so one crashing component doesn't take down the
 * entire page. Shows the error message with a retry button.
 */
export class ShowcaseErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ShowcaseErrorBoundary] Caught in: ${this.props.name ?? 'unknown'}`);
    console.error(error);
    console.error(info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          // The gate's handle on a caught crash (DOR-1117). The visible copy
          // ("X crashed") is prose and will be rewritten one day; an attribute
          // is a contract. `every-showcase-mounts.test.tsx` counts these after
          // rendering every page, so a showcase that throws is a red test
          // rather than a tidy red card nobody loads.
          data-showcase-error={this.props.name ?? 'unknown'}
          className="border-destructive/30 bg-destructive/5 flex flex-col items-start gap-3 rounded-lg border p-4"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="text-destructive size-4" />
            <span className="text-destructive text-sm font-medium">
              {this.props.name ? `${this.props.name} crashed` : 'Showcase crashed'}
            </span>
          </div>
          <pre className="text-destructive/80 w-full overflow-x-auto text-xs">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs transition-colors"
          >
            <RotateCcw className="size-3" />
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
