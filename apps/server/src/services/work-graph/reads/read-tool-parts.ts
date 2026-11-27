/**
 * What the work graph's read tools share (W4, DOR-4970; DOR-4972): the ports
 * the composition root hands them, the audit deps they read their reader
 * from, the MCP surface they all take, and the store they fail on until
 * startup installs it. Their page fields are the API's own
 * (`@dorkos/shared/paging`).
 *
 * @module services/work-graph/reads/read-tool-parts
 */
import {
  CapabilityToolError,
  type CapabilityDeps,
} from '../../core/capabilities/capability-definition.js';
import type { CapabilityInvocationContext } from '../../core/capabilities/index.js';
import type { AuditReader } from '../../audit/visibility.js';
import type { Db } from '@dorkos/db';
import { getWorkGraphDb, getWorkLinkStore, type WorkLinkStore } from '../index.js';

/** The audit deps a read takes its reader and roster from. */
export type AuditDeps = NonNullable<CapabilityDeps['auditDeps']>;

/**
 * What these reads take from other domains, passed in by the composition root
 * (`core/self-description/dorkos-registry.ts`), so the work graph imports none
 * of them (the services import rule, DOR-4924).
 */
export interface WorkGraphReadPorts {
  /** Who is reading, from the call's context: the audit read side's `readerFor`. */
  readerOf: (
    audit: Pick<AuditDeps, 'accounts'>,
    context?: CapabilityInvocationContext
  ) => AuditReader;
  /** The chats among these the reader may read: the audit read side's one rule. */
  readable: (reader: AuditReader, chatIds: readonly string[]) => ReadonlySet<string>;
  /** A chat's title, or null. */
  titleOf: (chatId: string) => Promise<string | null>;
  /** Whether a chat holds outside words a title of it may quote (DOR-3969). */
  holdsOutsideText: (chatId: string) => boolean;
  /** Mark the calling turn as one that read outside words, from a chat. */
  markOutside: (context: CapabilityInvocationContext) => void;
  /**
   * Whether the call names a person or a trusted caller: a person's session
   * on a REST read, a signed-in person's key, or a trusted caller. A read that
   * must not read as the owner for a caller nobody named asks this (DOR-4972).
   */
  namesPerson: (context?: CapabilityInvocationContext) => boolean;
}

/**
 * The audit deps these reads take their reader and roster from, throwing if
 * the registry was composed without them (a wiring bug, caught at boot).
 *
 * @param deps - The capability bag.
 */
export function requireAuditDeps(deps: CapabilityDeps): AuditDeps {
  if (!deps.auditDeps) {
    throw new Error('Work graph read invoked without auditDeps in the registry bag.');
  }
  return deps.auditDeps;
}

/** Both MCP servers, read-only, safe to repeat. */
export const READ_TOOL = {
  servers: ['in-session', 'external'] as ('in-session' | 'external')[],
  annotations: { idempotentHint: true },
};

/** The installed database and edge store, or "still starting" until startup installs them. */
export function workGraphDb(): { db: Db; links: WorkLinkStore } {
  const db = getWorkGraphDb();
  const links = getWorkLinkStore();
  if (!db || !links) {
    throw new CapabilityToolError({ code: 'NOT_READY', error: 'DorkOS is still starting.' });
  }
  return { db, links };
}
