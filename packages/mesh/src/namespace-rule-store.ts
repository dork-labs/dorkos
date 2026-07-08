/**
 * First-class store for cross-namespace ALLOW rules owned by Mesh (mesh #16).
 *
 * Mesh is the authority for which namespace pairs may communicate. Each rule is
 * projected one-directionally into Relay (Relay remains the enforcer), and the
 * topology view reads from THIS store instead of regexing Relay rule strings —
 * so a subject-grammar change can no longer silently corrupt the topology.
 *
 * @module mesh/namespace-rule-store
 */
import { and, eq } from 'drizzle-orm';
import { meshNamespaceRules, type Db } from '@dorkos/db';

/** A single cross-namespace allow pair. */
export interface NamespaceRule {
  sourceNamespace: string;
  targetNamespace: string;
}

/**
 * The narrow surface {@link TopologyManager} depends on. Backed by
 * {@link NamespaceRuleStore} in production; tests inject an in-memory fake.
 */
export interface NamespaceRuleStoreLike {
  /** List every cross-namespace allow pair. */
  list(): NamespaceRule[];
  /** Whether a specific allow pair exists. */
  has(sourceNamespace: string, targetNamespace: string): boolean;
  /** Add an allow pair (idempotent). */
  add(sourceNamespace: string, targetNamespace: string): void;
  /** Remove an allow pair. */
  remove(sourceNamespace: string, targetNamespace: string): void;
}

/**
 * SQLite-backed store of cross-namespace allow rules, following Mesh's existing
 * storage convention (the consolidated `@dorkos/db` database, like the agents
 * and denials tables).
 */
export class NamespaceRuleStore implements NamespaceRuleStoreLike {
  constructor(private readonly db: Db) {}

  /**
   * List every cross-namespace allow pair.
   *
   * @returns All stored allow pairs.
   */
  list(): NamespaceRule[] {
    return this.db
      .select({
        sourceNamespace: meshNamespaceRules.sourceNamespace,
        targetNamespace: meshNamespaceRules.targetNamespace,
      })
      .from(meshNamespaceRules)
      .all();
  }

  /**
   * Whether a specific allow pair exists.
   *
   * @param sourceNamespace - The source namespace.
   * @param targetNamespace - The target namespace.
   */
  has(sourceNamespace: string, targetNamespace: string): boolean {
    const rows = this.db
      .select({ sourceNamespace: meshNamespaceRules.sourceNamespace })
      .from(meshNamespaceRules)
      .where(
        and(
          eq(meshNamespaceRules.sourceNamespace, sourceNamespace),
          eq(meshNamespaceRules.targetNamespace, targetNamespace)
        )
      )
      .all();
    return rows.length > 0;
  }

  /**
   * Add an allow pair. Idempotent — re-adding an existing pair is a no-op.
   *
   * @param sourceNamespace - The source namespace.
   * @param targetNamespace - The target namespace.
   */
  add(sourceNamespace: string, targetNamespace: string): void {
    this.db
      .insert(meshNamespaceRules)
      .values({ sourceNamespace, targetNamespace, createdAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  }

  /**
   * Remove an allow pair. Removing a nonexistent pair is a no-op.
   *
   * @param sourceNamespace - The source namespace.
   * @param targetNamespace - The target namespace.
   */
  remove(sourceNamespace: string, targetNamespace: string): void {
    this.db
      .delete(meshNamespaceRules)
      .where(
        and(
          eq(meshNamespaceRules.sourceNamespace, sourceNamespace),
          eq(meshNamespaceRules.targetNamespace, targetNamespace)
        )
      )
      .run();
  }
}
