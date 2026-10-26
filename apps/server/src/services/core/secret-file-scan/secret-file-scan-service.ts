/**
 * Scan each agent's folder for secret-looking file names and tell the person
 * once per set of files (DOR-3292). See `scan-folder.ts` for what matches and
 * why names only.
 *
 * What a scan covers today: the agent's home folder. A managed workspace or a
 * room repo granted per turn is a follow-up.
 *
 * Where it says it: one `agent.secret_files` notification (person-only, never
 * a phone or a room). Never Activity: agents can read Activity, and a list of
 * where the secrets are is itself worth keeping from them. The agent page's
 * warning and "Move it out" follow with the designer's mocks.
 *
 * Scans run one at a time across all agents, so a discovery that adopts many
 * agents at once queues their walks instead of starting them all together.
 *
 * @module services/core/secret-file-scan/secret-file-scan-service
 */
import { createHash } from 'node:crypto';
import {
  scanFolderForSecretNames,
  type SecretFileFinding,
  type SecretFolderScan,
} from './scan-folder.js';
import { SECRET_FILES_LISTED } from '../../notifications/secret-file-notifications.js';

/** An agent to scan. */
export interface ScannedAgent {
  id: string;
  name: string;
  /** The folders it can read: its home today. */
  folders: string[];
}

/** What the service needs from the rest of the server. */
export interface SecretFileScanDeps {
  /** Raise the person-only notification. Never throws. */
  notify: (payload: {
    agentId: string;
    agentName: string;
    files: string[];
    total: number;
    fingerprint: string;
  }) => Promise<unknown>;
  /** Scan one folder. Defaults to the real walk. */
  scan?: (folder: string) => Promise<SecretFolderScan>;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/** The hash the notification dedupes on: every path found, sorted. */
export function findingsFingerprint(findings: readonly SecretFileFinding[]): string {
  const paths = findings.map((f) => f.path).sort();
  return createHash('sha256').update(JSON.stringify(paths)).digest('hex').slice(0, 32);
}

/** Scans agents' folders, one walk at a time, and tells the person. */
export class SecretFileScanService {
  private readonly running = new Map<string, Promise<void>>();
  /** Every scan waits for the one before it: at most one walk at a time. */
  private queue: Promise<void> = Promise.resolve();
  private readonly again = new Set<string>();

  constructor(private readonly deps: SecretFileScanDeps) {}

  /**
   * Scan one agent and tell the person if anything secret-looking is there.
   * Never throws. Concurrent calls for one agent coalesce into one more scan.
   *
   * @param agent - Who, and which folders.
   */
  async scanAgent(agent: ScannedAgent): Promise<void> {
    const inFlight = this.running.get(agent.id);
    if (inFlight) {
      this.again.add(agent.id);
      return inFlight;
    }
    const run = this.queue.then(() => this.runScan(agent));
    this.queue = run;
    const settled = run.finally(() => {
      this.running.delete(agent.id);
      if (this.again.delete(agent.id)) void this.scanAgent(agent);
    });
    this.running.set(agent.id, settled);
    return settled;
  }

  private async runScan(agent: ScannedAgent): Promise<void> {
    try {
      const scan = this.deps.scan ?? ((folder: string) => scanFolderForSecretNames(folder));
      const findings: SecretFileFinding[] = [];
      let truncated = false;
      for (const folder of new Set(agent.folders)) {
        const result = await scan(folder);
        findings.push(...result.findings);
        truncated ||= result.truncated;
      }
      if (truncated) {
        this.deps.logger?.warn('[SecretFiles] Stopped early in a large agent folder', {
          agentId: agent.id,
        });
      }
      if (findings.length === 0) return;
      await this.deps.notify({
        agentId: agent.id,
        agentName: agent.name,
        files: findings.map((f) => f.path).slice(0, SECRET_FILES_LISTED),
        total: findings.length,
        fingerprint: findingsFingerprint(findings),
      });
    } catch (err) {
      this.deps.logger?.warn('[SecretFiles] Could not scan an agent folder', {
        agentId: agent.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

let current: SecretFileScanService | undefined;

/** Set the process-wide service at boot. */
export function setSecretFileScanService(next: SecretFileScanService | undefined): void {
  current = next;
}

/** The process-wide service, once boot wired it. */
export function secretFileScanService(): SecretFileScanService | undefined {
  return current;
}
