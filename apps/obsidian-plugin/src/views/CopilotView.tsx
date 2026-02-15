import { ItemView, WorkspaceLeaf } from 'obsidian';
import { createRoot, Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NuqsAdapter } from 'nuqs/adapters/react';
import path from 'path';
import { setPlatformAdapter } from '@dorkos/client/lib/platform';
import { TransportProvider } from '@dorkos/client/contexts/TransportContext';
import { DirectTransport } from '@dorkos/client/lib/direct-transport';
import { createObsidianAdapter } from '../lib/obsidian-adapter';
import { ObsidianProvider } from '../contexts/ObsidianContext';
import { ObsidianApp } from '../components/ObsidianApp';
import { AgentManager } from '@dorkos/server/services/agent-manager';
import { TranscriptReader } from '@dorkos/server/services/transcript-reader';
import { CommandRegistryService } from '@dorkos/server/services/command-registry';
import type CopilotPlugin from '../main';
// Vite extracts this to styles.css which Obsidian auto-loads
import '../styles/plugin.css';

export const VIEW_TYPE_COPILOT = 'dorkos-copilot-view';

export class CopilotView extends ItemView {
  root: Root | null = null;
  plugin: CopilotPlugin;
  queryClient: QueryClient;

  constructor(leaf: WorkspaceLeaf, plugin: CopilotPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
    });
  }

  getViewType(): string {
    return VIEW_TYPE_COPILOT;
  }
  getDisplayText(): string {
    return 'Copilot';
  }
  getIcon(): string {
    return 'bot';
  }

  async onOpen(): Promise<void> {
    setPlatformAdapter(createObsidianAdapter(this.app));

    // Resolve paths: Obsidian vault is workspace/, repo root is its parent
    const vaultPath = (this.app.vault.adapter as unknown as { basePath: string }).basePath;
    const repoRoot = path.resolve(vaultPath, '..');

    // Create service instances for DirectTransport
    // All services need the repo root (where .claude/ and SDK transcripts live)
    const agentManager = new AgentManager(repoRoot);
    const transcriptReader = new TranscriptReader();
    const commandRegistry = new CommandRegistryService(repoRoot);

    const transport = new DirectTransport({
      agentManager,
      transcriptReader,
      commandRegistry,
      vaultRoot: repoRoot,
    });

    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('copilot-view-content');

    this.root = createRoot(container);
    this.root.render(
      <NuqsAdapter>
        <ObsidianProvider app={this.app}>
          <QueryClientProvider client={this.queryClient}>
            <TransportProvider transport={transport}>
              <ObsidianApp />
            </TransportProvider>
          </QueryClientProvider>
        </ObsidianProvider>
      </NuqsAdapter>
    );
  }

  async onClose(): Promise<void> {
    this.root?.unmount();
    this.root = null;
  }
}
