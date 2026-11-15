/** Per-command chat metadata for a sidecar shared by many DorkOS chats. */
import { writeFile, rename, rm } from 'node:fs/promises';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

/** Generate the dependency-free plugin that OpenCode loads inside its own process. */
export function sessionEnvironmentPlugin(directory: string): string {
  return `import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
export default async ({ client }) => ({
  'shell.env': async (input, output) => {
    // OpenCode sessionID is a vendor id, never the DorkOS chat id.
    // Children inherit their root chat's binding, without changing process.env.
    // Any unexpected failure leaves the id unset rather than failing the command.
    try {
      let id = input.sessionID;
      const seen = new Set();
      while (id && !seen.has(id) && seen.size < 32) {
        seen.add(id);
        const name = createHash('sha256').update(id).digest('hex');
        try {
          output.env.DORKOS_SESSION_ID = await readFile(join(${JSON.stringify(directory)}, name), 'utf8');
          return;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const result = await client.session.get({ path: { id } });
        id = result.data?.parentID;
      }
    } catch {
      delete output.env.DORKOS_SESSION_ID;
    }
  }
});
`;
}

/** Owns only generated plugin code and non-secret bindings; never credentials. */
export class OpenCodeSessionEnvironment {
  private files?: { directory: string; plugin: string };

  private prepare(): { directory: string; plugin: string } {
    if (this.files) return this.files;
    const directory = mkdtempSync(join(tmpdir(), 'dorkos-opencode-env-'));
    const plugin = join(directory, 'session-environment.mjs');
    try {
      writeFileSync(plugin, sessionEnvironmentPlugin(directory), { mode: 0o600 });
      return (this.files = { directory, plugin: pathToFileURL(plugin).href });
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  /** Plugin URL for the sidecar config; lazy so constructing a manager does no I/O. */
  plugin(): string {
    return this.prepare().plugin;
  }

  /** Persist the server-owned DorkOS id before OpenCode receives any turn input. */
  async bind(sessionId: string, openCodeSessionId: string): Promise<void> {
    const { directory } = this.prepare();
    const name = createHash('sha256').update(openCodeSessionId).digest('hex');
    const temporary = join(directory, `binding-${randomUUID()}`);
    try {
      await writeFile(temporary, sessionId, { mode: 0o600, flag: 'wx' });
      await rename(temporary, join(directory, name));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Remove only this manager's generated files after its sidecar has stopped. */
  async close(): Promise<void> {
    if (this.files) await rm(this.files.directory, { recursive: true, force: true });
  }
}
