/**
 * Direct system methods factory — health, config, directory browsing, file
 * listing, git status, commands, models, capabilities, uploads, and templates
 * served via in-process services and direct filesystem access.
 *
 * Mirrors `transport/system-methods.ts` (the HTTP twin) so both Transport
 * implementations split along the same domain seams. Server-only system
 * operations (tunnel, reset, restart, scan, MCP keys) live in
 * `stub-methods.ts`.
 *
 * @module shared/lib/direct/system-methods
 */
import type { RuntimeCapabilities, SystemRequirements } from '@dorkos/shared/agent-runtime';
import type { TemplateEntry } from '@dorkos/shared/template-catalog';
import type { UploadFile, WriteFileResult } from '@dorkos/shared/transport';
import type {
  BrowseDirectoryResponse,
  HealthResponse,
  CommandRegistry,
  FileListResponse,
  ServerConfig,
  ModelOption,
  GitStatusResponse,
  GitStatusError,
  UploadResult,
  UploadProgress,
  SubagentInfo,
} from '@dorkos/shared/types';
import type { DirectTransportServices } from './services';

/**
 * Create the system/environment methods bound to the injected services.
 *
 * @param services - In-process service seams wired by the embedding host
 */
export function createDirectSystemMethods(services: DirectTransportServices) {
  return {
    // ── Directory Operations ───────────────────────────────────────────────

    async browseDirectory(
      dirPath?: string,
      showHidden?: boolean
    ): Promise<BrowseDirectoryResponse> {
      // In Obsidian/Electron, use direct filesystem access
      // This is a simplified implementation — the full security checks
      // are in the server route. For DirectTransport, we trust the local env.
      const fs = await import('fs/promises');
      const pathMod = await import('path');
      const os = await import('os');

      const HOME = os.default.homedir();
      const targetPath = dirPath || HOME;
      const resolved = await fs.default.realpath(targetPath);

      if (!resolved.startsWith(HOME)) {
        throw new Error('Access denied: path outside home directory');
      }

      const dirents = await fs.default.readdir(resolved, { withFileTypes: true });
      const entries = dirents
        .filter((d) => d.isDirectory())
        .filter((d) => showHidden || !d.name.startsWith('.'))
        .map((d) => ({
          name: d.name,
          path: pathMod.default.join(resolved, d.name),
          isDirectory: true,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const parent = pathMod.default.dirname(resolved);
      const hasParent = parent !== resolved && parent.startsWith(HOME);

      return {
        path: resolved,
        entries,
        parent: hasParent ? parent : null,
      };
    },

    /** Create a new directory using direct filesystem access. */
    async createDirectory(parentPath: string, folderName: string): Promise<{ path: string }> {
      const fs = await import('fs/promises');
      const pathMod = await import('path');
      const newDirPath = pathMod.default.join(parentPath, folderName);

      try {
        await fs.default.access(newDirPath);
        throw new Error('Directory already exists');
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'Directory already exists') throw err;
        // Expected — directory does not exist yet
      }

      await fs.default.mkdir(newDirPath, { recursive: true });
      return { path: newDirPath };
    },

    async getDefaultCwd(): Promise<{ path: string }> {
      return { path: services.vaultRoot };
    },

    async listFiles(cwd: string): Promise<FileListResponse> {
      if (services.fileLister) {
        return services.fileLister.listFiles(cwd);
      }
      return { files: [], truncated: false, total: 0 };
    },

    /**
     * Write content back to an existing file, confined to `cwd`. Mirrors the
     * server route's optimistic-concurrency + atomic-write semantics with direct
     * filesystem access (the Obsidian/Electron host trusts the local env, as the
     * other direct fs methods do).
     */
    async writeFile(
      cwd: string,
      filePath: string,
      content: string,
      options?: { expectedHash?: string; expectedContent?: string }
    ): Promise<WriteFileResult> {
      const fs = await import('fs/promises');
      const pathMod = await import('path');
      const crypto = await import('crypto');
      const sha256 = (s: string) =>
        crypto.default.createHash('sha256').update(s, 'utf8').digest('hex');

      const target = pathMod.default.isAbsolute(filePath)
        ? filePath
        : pathMod.default.join(cwd, filePath);
      const resolved = await fs.default
        .realpath(target)
        .catch(() => pathMod.default.resolve(target));
      const root = await fs.default.realpath(cwd).catch(() => pathMod.default.resolve(cwd));
      // Confined to `cwd` only (not an outer HOME boundary like the HTTP route),
      // deliberately: the Obsidian/Electron host trusts the local env and a vault
      // can live anywhere on disk. `cwd` here is the vault-scoped working dir.
      if (resolved !== root && !resolved.startsWith(root + pathMod.default.sep)) {
        throw new Error('Access denied: path outside working directory');
      }

      let current: string;
      try {
        current = await fs.default.readFile(resolved, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('File not found');
        throw err;
      }

      const currentHash = sha256(current);
      // A hash wins if present; otherwise hash the baseline content (first save).
      const effectiveExpected =
        options?.expectedHash ??
        (options?.expectedContent !== undefined ? sha256(options.expectedContent) : undefined);
      if (effectiveExpected !== undefined && effectiveExpected !== currentHash) {
        return { ok: false, conflict: { currentHash, currentContent: current } };
      }

      const newHash = sha256(content);
      if (newHash === currentHash) return { ok: true, hash: currentHash };

      const tmp = `${resolved}.${crypto.default.randomBytes(6).toString('hex')}.tmp`;
      try {
        await fs.default.writeFile(tmp, content, 'utf8');
        await fs.default.rename(tmp, resolved);
      } catch (err) {
        await fs.default.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      return { ok: true, hash: newHash };
    },

    async getGitStatus(cwd?: string): Promise<GitStatusResponse | GitStatusError> {
      if (services.gitStatus) {
        return services.gitStatus.getGitStatus(cwd || services.vaultRoot);
      }
      return { error: 'not_git_repo' as const };
    },

    // ── Commands / Health / Config ─────────────────────────────────────────

    async getCommands(
      refresh?: boolean,
      _cwd?: string,
      _opts?: { sessionId?: string }
    ): Promise<CommandRegistry> {
      // Embedded mode currently collapses to the single Claude runtime; sessionId
      // is accepted for Transport parity but unused. Task 2.7 will teach
      // DirectTransport to route per-session across multiple runtimes.
      return services.commandRegistry.getCommands(refresh);
    },

    async health(): Promise<HealthResponse> {
      return { status: 'ok', version: '0.1.0', uptime: 0 };
    },

    async getConfig(): Promise<ServerConfig> {
      return {
        version: '0.1.0',
        latestVersion: null,
        isDevMode: true,
        dismissedUpgradeVersions: [],
        port: 0,
        uptime: 0,
        workingDirectory: services.vaultRoot,
        nodeVersion: process.version,
        claudeCliPath: null,
        tunnel: {
          enabled: false,
          connected: false,
          url: null,
          port: null,
          startedAt: null,
          authEnabled: false,
          tokenConfigured: false,
          domain: null,
          passcodeEnabled: false,
        },
        boundary: services.vaultRoot,
        dorkHome: services.vaultRoot,
        scheduler: {
          maxConcurrentRuns: 1,
          timezone: null,
          retentionCount: 100,
        },
        logging: {
          level: 'info',
          maxLogSizeKb: 500,
          maxLogFiles: 14,
        },
      };
    },

    // ── Runtime Catalog ────────────────────────────────────────────────────

    async getModels(_opts?: { sessionId?: string }): Promise<ModelOption[]> {
      // SDK-driven via the embedded runtime's RuntimeCache (memory → disk → lazy
      // warm-up) — the same source as the server's `/api/models` route, so the
      // catalog derives identically on every transport rather than from a
      // hand-maintained list that drifts. sessionId is accepted for Transport
      // parity but unused until embedded mode routes per-session across multiple
      // runtimes (Task 2.7).
      return services.runtime.getSupportedModels();
    },

    async getSubagents(_opts?: { sessionId?: string }): Promise<SubagentInfo[]> {
      // SDK-driven via the embedded runtime, mirroring getModels(). sessionId is
      // accepted for Transport parity but unused until embedded mode routes
      // per-session across multiple runtimes (Task 2.7).
      return services.runtime.getSupportedSubagents();
    },

    async getCapabilities(): Promise<{
      capabilities: Record<string, RuntimeCapabilities>;
      defaultRuntime: string;
    }> {
      // Delegate to the runtime's getCapabilities() and wrap for the transport response shape.
      const caps = services.runtime.getCapabilities();
      return {
        capabilities: { [caps.type]: caps },
        defaultRuntime: caps.type,
      };
    },

    async checkRequirements(): Promise<SystemRequirements> {
      const runtime = services.runtime;
      const deps =
        'checkDependencies' in runtime
          ? await (runtime as { checkDependencies(): Promise<unknown[]> }).checkDependencies()
          : [];
      const runtimes = {
        [runtime.getCapabilities().type]: {
          dependencies: deps as SystemRequirements['runtimes'][string]['dependencies'],
        },
      };
      const allSatisfied = Object.values(runtimes).every((r) =>
        r.dependencies.every((d) => d.status === 'satisfied')
      );
      return { runtimes, allSatisfied };
    },

    // ── File Uploads ───────────────────────────────────────────────────────

    /** Upload files to `{cwd}/.dork/.temp/uploads/` using direct filesystem access. */
    async uploadFiles(
      files: UploadFile[],
      cwd: string,
      _onProgress?: (progress: UploadProgress) => void
    ): Promise<UploadResult[]> {
      const fs = await import('fs/promises');
      const pathMod = await import('path');
      const { randomUUID } = await import('crypto');

      const uploadDir = pathMod.default.join(cwd, '.dork', '.temp', 'uploads');
      await fs.default.mkdir(uploadDir, { recursive: true });

      const results: UploadResult[] = [];
      for (const file of files) {
        const base = pathMod.default.basename(file.name);
        const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${randomUUID().slice(0, 8)}-${safe}`;
        const savedPath = pathMod.default.join(uploadDir, filename);

        const buffer = Buffer.from(await file.arrayBuffer());
        await fs.default.writeFile(savedPath, buffer);

        results.push({
          originalName: file.name,
          savedPath,
          filename,
          size: file.size,
          mimeType: file.type,
        });
      }

      return results;
    },

    // ── Templates ──────────────────────────────────────────────────────────

    async getTemplates(): Promise<TemplateEntry[]> {
      const { DEFAULT_TEMPLATES } = await import('@dorkos/shared/template-catalog');
      return DEFAULT_TEMPLATES;
    },
  };
}
