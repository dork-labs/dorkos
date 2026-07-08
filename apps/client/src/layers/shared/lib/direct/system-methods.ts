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
import { deriveRuntimeReadiness } from '@dorkos/shared/agent-runtime';
import type { TemplateEntry } from '@dorkos/shared/template-catalog';
import type { UploadFile, WriteFileResult } from '@dorkos/shared/transport';
import type {
  BrowseDirectoryResponse,
  HealthResponse,
  CommandRegistry,
  FileListResponse,
  FileEntry,
  FileTreeResponse,
  FileContentResponse,
  CreateEntryResponse,
  FileMutationResponse,
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
 * Directories the in-process file explorer hides by default (no `git
 * check-ignore` available in the embedded host, so this approximates gitignore).
 */
const DIRECT_EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '__pycache__',
  '.cache',
]);

/**
 * Max bytes {@link readFileContent} will read as text. Mirrors the server's
 * `FILE_LIMITS.MAX_TEXT_FILE_BYTES` (apps/server/src/config/constants.ts); the
 * client can't import server config, so the value is duplicated intentionally.
 */
const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Build an Error carrying a stable `code`, matching the codes `HttpTransport`
 * surfaces (`CONFLICT`, `DIR_NOT_EMPTY`, `NOT_FOUND`, `REFUSE_ROOT`) so callers
 * (Chunk B) can branch on `err.code` regardless of transport.
 */
function codedError(message: string, code: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/** POSIX-separated path of `abs` relative to `root`, for wire responses. */
function toPosixRel(pathMod: typeof import('path'), root: string, abs: string): string {
  return pathMod.relative(root, abs).split(pathMod.sep).join('/');
}

/**
 * Resolve `relPath` within `cwd` for the in-process transport, rejecting escapes.
 * Confined to `cwd` only (the embedded host trusts the local env, as the other
 * direct fs methods do). Returns the realpath'd root and target.
 *
 * When the target does not exist, its nearest existing ancestor is `realpath`'d
 * and re-checked, so a symlinked parent (`cwd/link -> /outside`) can't smuggle a
 * create/rename write outside `cwd` (a not-yet-existing path would otherwise skip
 * symlink resolution and pass the string containment check).
 */
async function confineWithin(
  cwd: string,
  relPath: string
): Promise<{ root: string; resolved: string }> {
  const fs = (await import('fs/promises')).default;
  const pathMod = (await import('path')).default;
  const root = await fs.realpath(cwd).catch(() => pathMod.resolve(cwd));
  const target = pathMod.isAbsolute(relPath) ? relPath : pathMod.join(root, relPath);
  const resolved = await fs.realpath(target).catch(() => pathMod.resolve(target));
  const within = (p: string) => p === root || p.startsWith(root + pathMod.sep);
  if (!within(resolved)) {
    throw codedError('Access denied: path outside working directory', 'OUTSIDE_BOUNDARY');
  }
  const exists = await fs
    .access(resolved)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    let ancestor = pathMod.dirname(pathMod.resolve(target));
    for (;;) {
      const real = await fs.realpath(ancestor).catch(() => null);
      if (real !== null) {
        if (!within(real)) {
          throw codedError('Access denied: path outside working directory', 'OUTSIDE_BOUNDARY');
        }
        break;
      }
      const parent = pathMod.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  return { root, resolved };
}

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

    // The in-process host has no HTTP surface a webview can fetch, so local media
    // files can't be served by URL here; the canvas falls back to an unavailable
    // state. Remote (https) and data: sources still render (the client uses them
    // directly, without this method).
    mediaUrl(_cwd: string, _filePath: string): string | null {
      return null;
    },

    // The embedded terminal is a web-only surface: it needs a server-side PTY
    // and a WebSocket byte channel the in-process host does not provide. The tab
    // is gated on `supportsTerminal`, so `openTerminal` should never be reached;
    // it throws 'unsupported' as a hard guard.
    supportsTerminal: false as const,
    openTerminal(): Promise<never> {
      return Promise.reject(new Error('unsupported'));
    },
    writeTerminal(): void {
      throw new Error('unsupported');
    },
    resizeTerminal(): void {
      throw new Error('unsupported');
    },

    // ── Workbench file service (in-process fs) ─────────────────────────────

    /**
     * List one directory level for the file explorer via direct fs. Filters
     * dotfiles and well-known build/dependency directories by default; unlike the
     * HTTP route it has no `git check-ignore`, so gitignore honoring is
     * approximated by {@link DIRECT_EXCLUDED_DIRS}.
     */
    async readFileTree(
      cwd: string,
      options?: { path?: string; depth?: number; showHidden?: boolean }
    ): Promise<FileTreeResponse> {
      const fs = (await import('fs/promises')).default;
      const pathMod = (await import('path')).default;
      const toPosix = (r: string) => r.split(pathMod.sep).join('/');
      const showHidden = options?.showHidden ?? false;
      const { root, resolved: base } = await confineWithin(cwd, options?.path ?? '.');

      const describe = async (abs: string, name: string): Promise<FileEntry | null> => {
        const lst = await fs.lstat(abs).catch(() => null);
        if (!lst) return null;
        const isSymlink = lst.isSymbolicLink();
        const st = isSymlink ? await fs.stat(abs).catch(() => lst) : lst;
        const type = st.isDirectory() ? 'dir' : 'file';
        return {
          name,
          path: toPosix(pathMod.relative(root, abs)),
          type,
          size: st.isDirectory() ? 0 : st.size,
          mtime: Math.floor(st.mtimeMs),
          isSymlink,
        };
      };

      const collect = async (dir: string, depth: number): Promise<FileEntry[]> => {
        const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        const kept = dirents.filter((d) => {
          if (d.name === '.git') return false;
          if (!showHidden && d.name.startsWith('.')) return false;
          if (!showHidden && d.isDirectory() && DIRECT_EXCLUDED_DIRS.has(d.name)) return false;
          return true;
        });
        const described: FileEntry[] = [];
        for (const d of kept) {
          const entry = await describe(pathMod.join(dir, d.name), d.name);
          if (entry) described.push(entry);
        }
        described.sort((a, b) =>
          a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
        );
        const out: FileEntry[] = [];
        for (const entry of described) {
          out.push(entry);
          // Never recurse THROUGH a symlinked directory — following it would walk
          // a tree outside the confined working directory.
          if (depth > 1 && entry.type === 'dir' && !entry.isSymlink) {
            out.push(...(await collect(pathMod.join(root, ...entry.path.split('/')), depth - 1)));
          }
        }
        return out;
      };

      return { entries: await collect(base, options?.depth ?? 1) };
    },

    /**
     * Read a UTF-8 text file's content plus its SHA-256 via direct fs. Rejects
     * binary files (a NUL byte) and content over the 5 MB text cap.
     */
    async readFileContent(cwd: string, filePath: string): Promise<FileContentResponse> {
      const fs = (await import('fs/promises')).default;
      const crypto = (await import('crypto')).default;
      const { resolved } = await confineWithin(cwd, filePath);
      const stat = await fs.stat(resolved).catch(() => {
        throw codedError('File not found', 'NOT_FOUND');
      });
      if (!stat.isFile()) throw codedError('Not a regular file', 'NOT_A_FILE');
      if (stat.size > MAX_TEXT_FILE_BYTES)
        throw codedError('File too large to open as text', 'TOO_LARGE');
      const buffer = await fs.readFile(resolved);
      if (buffer.includes(0))
        throw codedError('Binary files cannot be opened as text', 'BINARY_FILE');
      const content = buffer.toString('utf8');
      const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
      return { content, hash, encoding: 'utf-8' };
    },

    /** Create a file or directory via direct fs; throws if the target exists. */
    async createEntry(
      cwd: string,
      filePath: string,
      type: 'file' | 'dir',
      content?: string
    ): Promise<CreateEntryResponse> {
      const fs = (await import('fs/promises')).default;
      const pathMod = (await import('path')).default;
      const { root, resolved } = await confineWithin(cwd, filePath);
      if (resolved === root) {
        throw codedError('Refusing to create over the working-directory root', 'REFUSE_ROOT');
      }
      const exists = await fs
        .access(resolved)
        .then(() => true)
        .catch(() => false);
      if (exists) throw codedError('Target already exists', 'CONFLICT');

      if (type === 'dir') {
        await fs.mkdir(resolved, { recursive: true });
      } else {
        await fs.mkdir(pathMod.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content ?? '', 'utf8');
      }
      return { ok: true, path: toPosixRel(pathMod, root, resolved) };
    },

    /** Delete a file or directory via direct fs; refuses the `cwd` root. */
    async deleteEntry(
      cwd: string,
      filePath: string,
      options?: { recursive?: boolean }
    ): Promise<FileMutationResponse> {
      const fs = (await import('fs/promises')).default;
      const { root, resolved } = await confineWithin(cwd, filePath);
      if (resolved === root) {
        throw codedError('Refusing to delete the working-directory root', 'REFUSE_ROOT');
      }
      const recursive = options?.recursive ?? false;
      const stat = await fs.lstat(resolved).catch(() => {
        throw codedError('Path not found', 'NOT_FOUND');
      });
      if (stat.isDirectory() && !recursive) {
        const children = await fs.readdir(resolved);
        if (children.length > 0) {
          throw codedError('Directory is not empty; pass recursive', 'DIR_NOT_EMPTY');
        }
      }
      await fs.rm(resolved, { recursive, force: false }).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') throw codedError('Path not found', 'NOT_FOUND');
        if (err.code === 'ENOTEMPTY') {
          throw codedError('Directory is not empty; pass recursive', 'DIR_NOT_EMPTY');
        }
        throw err;
      });
      return { ok: true };
    },

    /** Move or rename an entry via direct fs; throws if the target exists. */
    async renameEntry(cwd: string, from: string, to: string): Promise<FileMutationResponse> {
      const fs = (await import('fs/promises')).default;
      const pathMod = (await import('path')).default;
      const { root, resolved: fromResolved } = await confineWithin(cwd, from);
      const { resolved: toResolved } = await confineWithin(cwd, to);
      if (fromResolved === root || toResolved === root) {
        throw codedError('Refusing to move the working-directory root', 'REFUSE_ROOT');
      }
      const sourceExists = await fs
        .access(fromResolved)
        .then(() => true)
        .catch(() => false);
      if (!sourceExists) throw codedError('Source not found', 'NOT_FOUND');
      const targetExists = await fs
        .access(toResolved)
        .then(() => true)
        .catch(() => false);
      if (targetExists) throw codedError('Target already exists', 'CONFLICT');
      await fs.mkdir(pathMod.dirname(toResolved), { recursive: true });
      await fs.rename(fromResolved, toResolved);
      return { ok: true };
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
      _opts?: { sessionId?: string; runtime?: string }
    ): Promise<CommandRegistry> {
      // Embedded mode currently collapses to the single Claude runtime; sessionId
      // and runtime are accepted for Transport parity but unused. Task 2.7 will
      // teach DirectTransport to route per-session across multiple runtimes.
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

    async getModels(_opts?: { sessionId?: string; runtime?: string }): Promise<ModelOption[]> {
      // SDK-driven via the embedded runtime's RuntimeCache (memory → disk → lazy
      // warm-up) — the same source as the server's `/api/models` route, so the
      // catalog derives identically on every transport rather than from a
      // hand-maintained list that drifts. sessionId/runtime are accepted for
      // Transport parity but unused: embedded mode collapses to the single
      // embedded runtime until it routes per-session across multiple runtimes
      // (Task 2.7).
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
      const type = runtime.getCapabilities().type;
      const deps = (
        'checkDependencies' in runtime
          ? await (runtime as { checkDependencies(): Promise<unknown[]> }).checkDependencies()
          : []
      ) as SystemRequirements['runtimes'][string]['dependencies'];
      // Project the same Ready/Connect state the HTTP route derives, so both
      // transports present readiness identically.
      const runtimes: SystemRequirements['runtimes'] = {
        [type]: { dependencies: deps, ...deriveRuntimeReadiness(type, deps) },
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
