/**
 * System Transport methods factory — filesystem, config, health, tunnel, admin,
 * discovery, activity, templates, uploads, and agent config.
 *
 * @module shared/lib/transport/system-methods
 */
import type {
  BrowseDirectoryResponse,
  CommandRegistry,
  FileListResponse,
  HealthResponse,
  ServerConfig,
  ModelOption,
  SubagentInfo,
  GitStatusResponse,
  GitStatusError,
  UploadResult,
  UploadProgress,
} from '@dorkos/shared/types';
import type {
  UploadFile,
  McpConfigResponse,
  WriteFileResult,
  RuntimeProvisionProgress,
  RuntimeProvisionResult,
} from '@dorkos/shared/transport';
import type {
  StoreCredentialResult,
  DelegatedLoginResult,
  OpenRouterKeyResult,
  OpenRouterOAuthStart,
  OpenRouterOAuthStatus,
  OpenRouterModel,
  OllamaStatus,
  OllamaModelCatalog,
  OllamaPullProgress,
  OllamaPullResult,
} from '@dorkos/shared/runtime-connect';
import type { ListActivityQuery, ListActivityResponse } from '@dorkos/shared/activity-schemas';
import type { TemplateEntry } from '@dorkos/shared/template-catalog';
import type { RuntimeCapabilities, SystemRequirements } from '@dorkos/shared/agent-runtime';
import type { TransportScanOptions, TransportScanEvent } from '@dorkos/shared/mesh-schemas';
import { fetchJSON, buildQueryString } from './http-client';
import { parseSSEStream } from './sse-parser';

/**
 * Create all system-level methods bound to a base URL.
 * Covers filesystem, config, health, tunnel, admin, discovery scan, activity,
 * templates, file uploads, and agent configuration.
 *
 * @param baseUrl - Server base URL
 */
export function createSystemMethods(baseUrl: string) {
  return {
    // ── Filesystem ────────────────────────────────────────────────────────

    browseDirectory(dirPath?: string, showHidden?: boolean): Promise<BrowseDirectoryResponse> {
      const qs = buildQueryString({ path: dirPath, showHidden: showHidden || undefined });
      return fetchJSON<BrowseDirectoryResponse>(baseUrl, `/directory${qs}`);
    },

    createDirectory(parentPath: string, folderName: string): Promise<{ path: string }> {
      return fetchJSON<{ path: string }>(baseUrl, '/directory', {
        method: 'POST',
        body: JSON.stringify({ parentPath, folderName }),
      });
    },

    getDefaultCwd(): Promise<{ path: string }> {
      return fetchJSON<{ path: string }>(baseUrl, '/directory/default');
    },

    listFiles(cwd: string): Promise<FileListResponse> {
      const params = new URLSearchParams({ cwd });
      return fetchJSON<FileListResponse>(baseUrl, `/files?${params}`);
    },

    async writeFile(
      cwd: string,
      filePath: string,
      content: string,
      options?: { expectedHash?: string; expectedContent?: string }
    ): Promise<WriteFileResult> {
      // Raw fetch (not fetchJSON) so the 409 body — the current on-disk bytes —
      // survives; fetchJSON discards response bodies on non-OK.
      const res = await fetch(`${baseUrl}/files/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd,
          path: filePath,
          content,
          expectedHash: options?.expectedHash,
          expectedContent: options?.expectedContent,
        }),
      });
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}));
        return {
          ok: false,
          conflict: { currentHash: data.currentHash, currentContent: data.currentContent },
        };
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: res.statusText }));
        const err = new Error(data.error || `HTTP ${res.status}`) as Error & {
          code?: string;
          status?: number;
        };
        err.code = data.code;
        err.status = res.status;
        throw err;
      }
      const data = (await res.json()) as { hash: string };
      return { ok: true, hash: data.hash };
    },

    getGitStatus(cwd?: string): Promise<GitStatusResponse | GitStatusError> {
      const qs = buildQueryString({ dir: cwd });
      return fetchJSON<GitStatusResponse | GitStatusError>(baseUrl, `/git/status${qs}`);
    },

    // ── Commands ──────────────────────────────────────────────────────────

    getCommands(
      refresh = false,
      cwd?: string,
      opts?: { sessionId?: string }
    ): Promise<CommandRegistry> {
      const qs = buildQueryString({
        refresh: refresh || undefined,
        cwd,
        sessionId: opts?.sessionId,
      });
      return fetchJSON<CommandRegistry>(baseUrl, `/commands${qs}`);
    },

    // ── Config & Health ───────────────────────────────────────────────────

    health(): Promise<HealthResponse> {
      return fetchJSON<HealthResponse>(baseUrl, '/health');
    },

    getConfig(): Promise<ServerConfig> {
      return fetchJSON<ServerConfig>(baseUrl, '/config');
    },

    async updateConfig(patch: Record<string, unknown>): Promise<void> {
      await fetchJSON<void>(baseUrl, '/config', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
    },

    getModels(opts?: { sessionId?: string }): Promise<ModelOption[]> {
      const qs = buildQueryString({ sessionId: opts?.sessionId });
      return fetchJSON<{ models: ModelOption[] }>(baseUrl, `/models${qs}`).then((r) => r.models);
    },

    getSubagents(opts?: { sessionId?: string }): Promise<SubagentInfo[]> {
      const qs = buildQueryString({ sessionId: opts?.sessionId });
      return fetchJSON<{ subagents: SubagentInfo[] }>(baseUrl, `/subagents${qs}`).then(
        (r) => r.subagents
      );
    },

    getCapabilities(): Promise<{
      capabilities: Record<string, RuntimeCapabilities>;
      defaultRuntime: string;
    }> {
      return fetchJSON(baseUrl, '/capabilities');
    },

    checkRequirements(): Promise<SystemRequirements> {
      return fetchJSON<SystemRequirements>(baseUrl, '/system/requirements');
    },

    async provisionOpenCode(
      onProgress?: (progress: RuntimeProvisionProgress) => void
    ): Promise<RuntimeProvisionResult> {
      const response = await fetch(`${baseUrl}/runtimes/opencode/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({
          error: response.statusText,
        }))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }

      // Progress frames stream as `progress` events; the terminal `result` event
      // carries the outcome.
      const reader = response.body!.getReader();
      let result: RuntimeProvisionResult = {
        ok: false,
        error: 'Provisioning ended without a result',
      };
      for await (const event of parseSSEStream<RuntimeProvisionProgress | RuntimeProvisionResult>(
        reader
      )) {
        if (event.type === 'result') {
          result = event.data as RuntimeProvisionResult;
        } else if (event.type === 'progress') {
          onProgress?.(event.data as RuntimeProvisionProgress);
        }
      }
      return result;
    },

    // ── Runtime Connect (terminal-free auth) ──────────────────────────────

    storeRuntimeCredential(type: string, secret: string): Promise<StoreCredentialResult> {
      return fetchJSON<StoreCredentialResult>(
        baseUrl,
        `/runtimes/${encodeURIComponent(type)}/credential`,
        { method: 'POST', body: JSON.stringify({ secret }) }
      );
    },

    storeProviderCredential(
      providerId: string,
      secret: string,
      baseURL?: string | null
    ): Promise<StoreCredentialResult> {
      return fetchJSON<StoreCredentialResult>(baseUrl, '/runtimes/opencode/provider/credential', {
        method: 'POST',
        body: JSON.stringify({ providerId, secret, baseURL: baseURL ?? null }),
      });
    },

    delegateRuntimeLogin(type: string): Promise<DelegatedLoginResult> {
      return fetchJSON<DelegatedLoginResult>(
        baseUrl,
        `/runtimes/${encodeURIComponent(type)}/login`,
        { method: 'POST' }
      );
    },

    storeOpenRouterKey(key: string): Promise<OpenRouterKeyResult> {
      return fetchJSON<OpenRouterKeyResult>(baseUrl, '/runtimes/opencode/openrouter/key', {
        method: 'POST',
        body: JSON.stringify({ key }),
      });
    },

    startOpenRouterOAuth(): Promise<OpenRouterOAuthStart> {
      return fetchJSON<OpenRouterOAuthStart>(baseUrl, '/runtimes/opencode/openrouter/oauth/start', {
        method: 'POST',
      });
    },

    getOpenRouterOAuthStatus(state: string): Promise<OpenRouterOAuthStatus> {
      const qs = buildQueryString({ state });
      return fetchJSON<OpenRouterOAuthStatus>(
        baseUrl,
        `/runtimes/opencode/openrouter/oauth/status${qs}`
      );
    },

    getOpenRouterModels(): Promise<OpenRouterModel[]> {
      return fetchJSON<{ models: OpenRouterModel[] }>(
        baseUrl,
        '/runtimes/opencode/openrouter/models'
      ).then((r) => r.models);
    },

    detectOllama(): Promise<OllamaStatus> {
      return fetchJSON<OllamaStatus>(baseUrl, '/runtimes/opencode/ollama');
    },

    getOllamaModelCatalog(): Promise<OllamaModelCatalog> {
      return fetchJSON<OllamaModelCatalog>(baseUrl, '/runtimes/opencode/ollama/models');
    },

    async pullOllamaModel(
      model: string,
      onProgress?: (progress: OllamaPullProgress) => void
    ): Promise<OllamaPullResult> {
      const response = await fetch(`${baseUrl}/runtimes/opencode/ollama/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({
          error: response.statusText,
        }))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }

      // Progress frames stream as `progress` events; the terminal `result` event
      // carries the outcome (mirrors provisionOpenCode).
      const reader = response.body!.getReader();
      let result: OllamaPullResult = {
        ok: false,
        model,
        error: 'The pull ended without a result',
      };
      for await (const event of parseSSEStream<OllamaPullProgress | OllamaPullResult>(reader)) {
        if (event.type === 'result') {
          result = event.data as OllamaPullResult;
        } else if (event.type === 'progress') {
          onProgress?.(event.data as OllamaPullProgress);
        }
      }
      return result;
    },

    // ── Tunnel ────────────────────────────────────────────────────────────

    startTunnel(): Promise<{ url: string }> {
      return fetchJSON<{ url: string }>(baseUrl, '/tunnel/start', { method: 'POST' });
    },

    async stopTunnel(): Promise<void> {
      await fetchJSON<{ ok: boolean }>(baseUrl, '/tunnel/stop', { method: 'POST' });
    },

    verifyTunnelPasscode(
      passcode: string
    ): Promise<{ ok: boolean; error?: string; retryAfter?: number }> {
      return fetchJSON(baseUrl, '/tunnel/passcode/verify', {
        method: 'POST',
        body: JSON.stringify({ passcode }),
      });
    },

    checkTunnelSession(): Promise<{ authenticated: boolean; passcodeRequired: boolean }> {
      return fetchJSON(baseUrl, '/tunnel/passcode/session');
    },

    setTunnelPasscode(opts: { passcode?: string; enabled: boolean }): Promise<{ ok: boolean }> {
      return fetchJSON(baseUrl, '/tunnel/passcode/set', {
        method: 'POST',
        body: JSON.stringify(opts),
      });
    },

    // ── Admin ─────────────────────────────────────────────────────────────

    async resetAllData(confirm: string): Promise<{ message: string }> {
      const res = await fetch(`${baseUrl}/admin/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<{ message: string }>;
    },

    async restartServer(): Promise<{ message: string }> {
      const res = await fetch(`${baseUrl}/admin/restart`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<{ message: string }>;
    },

    // ── Discovery Scan (SSE) ──────────────────────────────────────────────

    async scan(
      options: TransportScanOptions,
      onEvent: (event: TransportScanEvent) => void,
      signal?: AbortSignal
    ): Promise<void> {
      const response = await fetch(`${baseUrl}/discovery/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
        signal,
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({
          error: response.statusText,
        }))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }

      const reader = response.body!.getReader();
      for await (const event of parseSSEStream<TransportScanEvent['data']>(reader)) {
        onEvent({ type: event.type, data: event.data } as TransportScanEvent);
      }
    },

    // ── Activity Feed ─────────────────────────────────────────────────────

    /** List activity events with optional filters and cursor-based pagination. */
    listActivityEvents(query?: Partial<ListActivityQuery>): Promise<ListActivityResponse> {
      const qs = buildQueryString({
        limit: query?.limit,
        before: query?.before,
        categories: query?.categories,
        actorType: query?.actorType,
        actorId: query?.actorId,
        since: query?.since,
      });
      return fetchJSON<ListActivityResponse>(baseUrl, `/activity${qs}`);
    },

    // ── Templates & MCP Config ────────────────────────────────────────────

    getTemplates(): Promise<TemplateEntry[]> {
      return fetchJSON<{ templates: TemplateEntry[] }>(baseUrl, '/templates').then(
        (r) => r.templates
      );
    },

    getMcpConfig(projectPath: string): Promise<McpConfigResponse> {
      return fetchJSON<McpConfigResponse>(
        baseUrl,
        `/mcp-config?path=${encodeURIComponent(projectPath)}`
      );
    },

    // ── File Uploads ──────────────────────────────────────────────────────

    async uploadFiles(
      files: UploadFile[],
      cwd: string,
      onProgress?: (progress: UploadProgress) => void
    ): Promise<UploadResult[]> {
      const formData = new FormData();
      for (const file of files) {
        const buffer = await file.arrayBuffer();
        formData.append('files', new Blob([buffer], { type: file.type }), file.name);
      }

      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${baseUrl}/uploads?cwd=${encodeURIComponent(cwd)}`);

        if (onProgress) {
          xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
              onProgress({
                loaded: e.loaded,
                total: e.total,
                percentage: Math.round((e.loaded / e.total) * 100),
              });
            }
          });
        }

        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve((JSON.parse(xhr.responseText) as { uploads: UploadResult[] }).uploads);
          } else {
            try {
              const error =
                (JSON.parse(xhr.responseText) as { error?: string }).error ?? `HTTP ${xhr.status}`;
              reject(new Error(error));
            } catch {
              reject(new Error(`HTTP ${xhr.status}`));
            }
          }
        });

        xhr.addEventListener('error', () => reject(new Error('Upload failed')));
        xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));

        xhr.send(formData);
      });
    },

    // ── Default Agent ─────────────────────────────────────────────────────

    async setDefaultAgent(agentName: string): Promise<void> {
      await fetchJSON<{ success: boolean }>(baseUrl, '/config/agents/defaultAgent', {
        method: 'PUT',
        body: JSON.stringify({ value: agentName }),
      });
    },

    // ── External MCP Access ──────────────────────────────────────────────

    async generateMcpApiKey(): Promise<{ apiKey: string }> {
      return fetchJSON<{ apiKey: string }>(baseUrl, '/config/mcp/generate-key', {
        method: 'POST',
      });
    },

    async deleteMcpApiKey(): Promise<{ success: boolean }> {
      return fetchJSON<{ success: boolean }>(baseUrl, '/config/mcp/api-key', {
        method: 'DELETE',
      });
    },
  };
}
