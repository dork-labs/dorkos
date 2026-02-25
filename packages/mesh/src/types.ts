/**
 * Core types for the Mesh agent discovery and registry.
 *
 * Defines the DiscoveryStrategy interface, discovery engine options,
 * and registry-related types used across all Mesh modules.
 *
 * @module mesh/types
 */
import type { AgentHints, AgentRuntime, DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';

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

// === Discovery Engine Options ===

/** Configuration for a discovery scan. */
export interface DiscoveryScanOptions {
  /** Root directories to scan. */
  roots: string[];

  /** Maximum directory depth to scan (default: 3). */
  maxDepth?: number;

  /** Strategies to use for detection (default: all built-in). */
  strategies?: DiscoveryStrategy[];

  /** Paths to skip during scanning (e.g., node_modules, .git). */
  skipPaths?: string[];
}

/** Result of a discovery scan. */
export interface DiscoveryScanResult {
  /** Candidates discovered during the scan. */
  candidates: DiscoveryCandidate[];

  /** Paths that were auto-imported (had existing .dork/agent.json). */
  autoImported: string[];

  /** Paths that were skipped (already registered or denied). */
  skipped: string[];

  /** Errors encountered during scanning (non-fatal). */
  errors: Array<{ path: string; error: string }>;
}

/** Filter function for checking if a path is already registered or denied. */
export interface RegistryFilter {
  /** Check if a path is already in the agent registry. */
  isRegistered(path: string): boolean;

  /** Check if a path has been denied. */
  isDenied(path: string): boolean;
}
