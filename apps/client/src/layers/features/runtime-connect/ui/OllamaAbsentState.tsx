/**
 * The Ollama-not-installed half of the OpenCode Local path (spec §13) — the
 * explainer and the platform-adaptive install affordance, kept beside
 * `OllamaLocalPath.tsx` rather than inside it so that file stays under the
 * repo's 500-line ceiling (DOR-424). The running half — status line, installed
 * models, curated shelf, pull-by-name — lives there; nothing here knows about it.
 *
 * @module features/runtime-connect/ui/OllamaAbsentState
 */
import { ExternalLink } from 'lucide-react';
import type { OllamaInstallMethod } from '@dorkos/shared/runtime-connect';
import { Button } from '@/layers/shared/ui';
import { localDeviceNoun } from '@/layers/shared/lib';
import { DependencyInstallHint } from '@/layers/entities/runtime';
import { useProvisionOllama, type UseProvisionOllama } from '../model/use-provision-ollama';
import { ConnectErrorRow, ConnectProgressRow } from './connect-feedback';

const OLLAMA_INSTALL_URL = 'https://ollama.com/download';

/**
 * The official one-line Ollama install command (Linux / manual). Shown to copy
 * when there is no password-free one-click path — it needs administrator access,
 * so it runs in the person's own terminal, never from the server.
 */
const OLLAMA_MANUAL_INSTALL_COMMAND = 'curl -fsSL https://ollama.com/install.sh | sh';

/** Props for {@link OllamaAbsentState}. */
export interface OllamaAbsentStateProps {
  /** The password-free install path detection resolved for this machine, if any. */
  installMethod?: OllamaInstallMethod;
}

/**
 * The Ollama-not-installed state (spec §13): a plain-language explainer plus a
 * platform-adaptive install affordance. Where a password-free path exists
 * (`brew`/`winget`) it offers a one-click guided install with streamed progress;
 * otherwise it shows the official command to copy. The ollama.com download link
 * stays visible in every state as the fallback.
 */
export function OllamaAbsentState({ installMethod }: OllamaAbsentStateProps) {
  const provision = useProvisionOllama();
  const oneClick = installMethod === 'brew' || installMethod === 'winget';

  return (
    <div className="space-y-3" data-testid="ollama-absent">
      <OllamaExplainer />
      {oneClick ? <OllamaOneClickInstall provision={provision} /> : <OllamaManualInstall />}
      <OllamaDownloadLink />
    </div>
  );
}

/** Plain-language explainer: what Ollama is and why DorkOS needs it for local models. */
function OllamaExplainer() {
  const noun = localDeviceNoun();
  return (
    <div className="space-y-1.5" data-testid="ollama-explainer">
      <p className="text-sm font-medium">Run AI models on {noun}</p>
      <p className="text-muted-foreground text-xs leading-relaxed">
        Ollama is a free, open-source app that runs AI models directly on {noun}. DorkOS uses it for
        local models. That is what keeps everything private: nothing you type leaves {noun}.
      </p>
    </div>
  );
}

/**
 * One-click guided install for a password-free platform: an Install button that
 * streams progress, then re-probes. A completed-and-running install hands off to
 * the parent panel (the detection re-probe flips it); installed-but-not-running
 * shows honest guidance to start it; a failure is retryable.
 */
function OllamaOneClickInstall({ provision }: { provision: UseProvisionOllama }) {
  if (provision.isPending) {
    return <ConnectProgressRow message={provision.progress?.message ?? 'Installing Ollama…'} />;
  }
  if (provision.result?.ok) {
    // Running → the panel is about to flip (detection re-probe); show a calm
    // transitional row, never the button. Not running → honest start guidance.
    return provision.result.status?.running ? (
      <ConnectProgressRow message="Ollama is ready…" />
    ) : (
      <p className="text-xs" data-testid="ollama-installed-not-running">
        Ollama is installed but not running yet. Open the Ollama app to start it, then check again.
      </p>
    );
  }
  if (provision.isError) {
    return (
      <ConnectErrorRow
        message={provision.errorMessage ?? 'Could not install Ollama.'}
        onRetry={provision.provision}
      />
    );
  }
  return (
    <Button size="sm" onClick={provision.provision} data-testid="ollama-install-oneclick">
      Install Ollama
    </Button>
  );
}

/** Manual (Linux / no package manager) install: the official command to copy and run in a terminal. */
function OllamaManualInstall() {
  return (
    <div className="space-y-2" data-testid="ollama-manual-install">
      <p className="text-muted-foreground text-xs leading-relaxed">
        Installing Ollama needs administrator access, so it runs in your terminal, not here. Copy
        this command, paste it into a terminal, and run it:
      </p>
      <DependencyInstallHint
        command={OLLAMA_MANUAL_INSTALL_COMMAND}
        copyLabel="Copy the Ollama install command"
      />
    </div>
  );
}

/** The ollama.com download link — the fallback shown in every not-installed state. */
function OllamaDownloadLink() {
  return (
    <a
      href={OLLAMA_INSTALL_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
    >
      Or download Ollama from ollama.com <ExternalLink className="size-3" />
    </a>
  );
}
