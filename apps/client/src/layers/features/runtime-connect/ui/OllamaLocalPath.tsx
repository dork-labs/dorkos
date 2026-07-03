/**
 * OpenCode Local (Ollama) path — the zero-auth hero (ADR-0318, T1 task 2.8).
 *
 * Detects a running Ollama and, when a model is pulled, connects with no
 * account (private, free). When Ollama is running without a model, a placeholder
 * marks where the guided hardware-aware pull lands (T2 task 3.6). When Ollama is
 * absent, we link to its installer — DorkOS detects, it never manages Ollama.
 *
 * @module features/runtime-connect/ui/OllamaLocalPath
 */
import { ExternalLink } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { ModelNatureBadge } from '@/layers/entities/runtime';
import {
  OLLAMA_PROVIDER_ID,
  useConnectOllama,
  useOllamaDetection,
} from '../model/use-opencode-provider';
import { ConnectErrorRow, ConnectProgressRow, ConnectedRow } from './connect-feedback';

const OLLAMA_INSTALL_URL = 'https://ollama.com/download';

/** The Local (Ollama) connect path. `active` gates detection to the open tab. */
export function OllamaLocalPath({ active }: { active: boolean }) {
  const detection = useOllamaDetection(active);
  const connect = useConnectOllama();

  if (connect.isSuccess) {
    return <ConnectedRow message="Connected to Ollama" />;
  }
  if (connect.isPending) {
    return <ConnectProgressRow message="Connecting to Ollama…" />;
  }
  if (connect.isError) {
    return (
      <ConnectErrorRow
        message={connect.errorMessage ?? 'Could not connect to Ollama.'}
        onRetry={() => detection.refetch()}
      />
    );
  }

  if (detection.isPending) {
    return <ConnectProgressRow message="Looking for Ollama on your machine…" />;
  }

  const status = detection.data;
  const running = status?.running ?? false;
  const models = status?.models ?? [];

  // Absent: link to the installer (one-click download; no further management).
  if (!running) {
    return (
      <div className="space-y-3" data-testid="ollama-absent">
        <p className="text-muted-foreground text-xs">
          Ollama isn’t running. Install it to run models locally — private and free, on your
          machine.
        </p>
        <a
          href={OLLAMA_INSTALL_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex"
        >
          <Button size="sm" variant="outline" className="gap-1.5">
            Install Ollama <ExternalLink className="size-3.5" />
          </Button>
        </a>
      </div>
    );
  }

  // Running but nothing pulled: the guided pull (T2, task 3.6) lands here.
  if (models.length === 0) {
    return (
      <div className="space-y-2" data-testid="ollama-no-model">
        <p className="text-muted-foreground text-xs">
          Ollama is running, but no model is pulled yet. A one-click guided model download is coming
          soon.
        </p>
        <a
          href={OLLAMA_INSTALL_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
        >
          Browse Ollama models <ExternalLink className="size-3" />
        </a>
      </div>
    );
  }

  // Running with a pulled model: connect with zero auth. Each model carries its
  // honest nature badge (local · private · free), never oversold as frontier.
  return (
    <div className="space-y-2" data-testid="ollama-models">
      <p className="text-muted-foreground text-xs">
        Private and free: runs on your machine; your code never leaves it.
      </p>
      <ul className="space-y-1.5">
        {models.map((model) => (
          <li key={model.name} className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-sm">{model.name}</span>
              <ModelNatureBadge provider={OLLAMA_PROVIDER_ID} modelId={model.name} />
            </div>
            <Button size="sm" onClick={() => connect.connect(model.name)}>
              Use this
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
