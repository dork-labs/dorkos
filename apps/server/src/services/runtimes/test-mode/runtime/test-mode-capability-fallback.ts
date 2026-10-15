import type { DependencyCheck } from '@dorkos/shared/agent-runtime';
import type { Session, TaskItem, ModelOption, CommandRegistry } from '@dorkos/shared/types';
import type { RelayCore } from '@dorkos/relay';

/** Original stateless capability fallbacks, without native state or authority. */
export class OriginalTestModeCapabilityFallback {
  async forkSession(): Promise<Session | null> {
    return null;
  }

  async reloadPlugins(): Promise<null> {
    return null;
  }

  async getSessionTasks(_projectDir: string, _id: string): Promise<TaskItem[]> {
    return [];
  }

  async getSessionETag(_projectDir: string, _id: string): Promise<string | null> {
    return null;
  }

  async getLastMessageIds(_sessionId: string): Promise<{ user: string; assistant: string } | null> {
    return null;
  }

  async readFromOffset(
    _projectDir: string,
    _id: string,
    _offset: number
  ): Promise<{ content: string; newOffset: number }> {
    return { content: '', newOffset: 0 };
  }

  async getSupportedModels(): Promise<ModelOption[]> {
    return [];
  }

  async getSupportedSubagents(): Promise<import('@dorkos/shared/types').SubagentInfo[]> {
    return [];
  }

  async getCommands(_forceRefresh?: boolean, _cwd?: string): Promise<CommandRegistry> {
    return { commands: [], lastScanned: '' };
  }

  async checkDependencies(): Promise<DependencyCheck[]> {
    return [
      {
        name: 'Test Mode Runtime',
        description: 'No external dependencies required.',
        status: 'satisfied',
      },
    ];
  }

  checkSessionHealth(): void {}

  /** Required by AgentRuntimeLike (relay package) for SDK session ID lookup. */
  getSdkSessionId(_id: string): string | undefined {
    return undefined;
  }

  setRelay(_relay: RelayCore): void {
    // No-op: retained to satisfy the AgentRuntime interface.
  }

  /**
   * Whether a session here carries the DorkOS room tools — always, since the
   * graduation (spec `tool-only-room-replies` §A2).
   *
   * A scripted turn reaches the real capability registry in-process, exactly as
   * claude-code does, so the claim is true rather than convenient: the scenarios
   * that mean to say something in a room call `post_to_room` through
   * {@link sayInRoom}, and the ones that mean to stay silent call nothing.
   *
   * It used to answer `false` unless the selected scenario opted in, which kept
   * the browser and eval suites on the auto-post path while the flip was an
   * experiment. There is no second path to keep them on, so the opt-in is gone
   * and each scenario says what it means outright.
   *
   * @returns `true`.
   */
  async carriesRoomTools(): Promise<boolean> {
    return true;
  }
}
