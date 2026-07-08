/**
 * Core types for the Mesh agent discovery and registry.
 *
 * Defines the DiscoveryStrategy interface used across all Mesh modules.
 *
 * @module mesh/types
 */
import type { AgentHints, AgentRuntime } from '@dorkos/shared/mesh-schemas';

// === Discovery Strategy Interface ===

/**
 * Pluggable strategy for detecting agent projects in a directory.
 *
 * Each strategy knows how to recognize a specific kind of agent project
 * (e.g., Claude Code, Cursor, Codex) by filesystem markers. Strategies
 * answer two questions: "Does this directory contain an agent?" and
 * "What can we infer about it?"
 */
export interface DiscoveryStrategy {
  /** Unique strategy name (e.g., "claude-code", "cursor", "codex"). */
  readonly name: string;

  /** The agent runtime this strategy detects. */
  readonly runtime: AgentRuntime;

  /**
   * Check whether the given directory matches this strategy's detection pattern.
   *
   * @param dir - Absolute path to a candidate directory
   * @returns `true` if the directory matches the strategy's markers
   */
  detect(dir: string): Promise<boolean>;

  /**
   * Extract hints from a matched directory.
   *
   * Should only be called after `detect()` returns `true`.
   *
   * @param dir - Absolute path to the matched directory
   * @returns Extracted hints (suggested name, runtime, capabilities, description)
   */
  extractHints(dir: string): Promise<AgentHints>;
}
