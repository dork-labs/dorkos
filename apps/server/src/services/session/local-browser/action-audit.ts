/** Browser action journal: no typed values, URL paths, queries, cookies, or page contents. */
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { LocalBrowserAction, LocalBrowserMode } from '@dorkos/shared/local-browser';

export interface LocalBrowserAuditRecord {
  operationId: string;
  sessionId: string | null;
  mode: LocalBrowserMode | null;
  kind: LocalBrowserAction['kind'];
  origin: string | null;
  connectionId: string | null;
  tabId: string | null;
  startedAt: string;
  phase: 'started' | 'finished';
  outcome: 'succeeded' | 'refused' | 'unknown';
}
export type LocalBrowserAuditWriter = (record: LocalBrowserAuditRecord) => Promise<void>;

/** Append each phase before returning. A started-only record means the result is unknown. */
export function localBrowserAuditWriter(dataDirectory: string): LocalBrowserAuditWriter {
  const directory = path.join(dataDirectory, 'local-browser');
  return async (record) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(path.join(directory, 'actions.jsonl'), JSON.stringify(record) + '\n', {
      mode: 0o600,
      flush: true,
    });
  };
}
