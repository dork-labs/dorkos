/**
 * Types for `text-only-scope.mjs`, the text-only lane's classifier (DOR-4834).
 *
 * @module scripts/text-only-scope
 */
import type ts from 'typescript';

type TS = typeof ts;

/** One changed literal: its file, old text and new text. */
export interface TextChange {
  path: string;
  old: string;
  now: string;
}

/** The whole decision, as the workflows read it. */
export interface Decision {
  textOnly: boolean;
  reason: string;
  vitestFiles: string[];
  browser: 'none' | 'specs' | 'full';
  specs: string[];
}

/** The JSX attributes whose plain string value is copy. */
export const COPY_ATTRIBUTES: Set<string>;

/** Why `path` can never be text only, or null. `status` is git's A, M or D. */
export function pathRefusal(path: string, status: string, pattern: string): string | null;

/** Why one side of a changed literal reads as code rather than copy, or null. */
export function valueRefusal(value: string, options?: { jsxText?: boolean }): string | null;

/** Why a changed literal sits where code reads it, or null when it is copy. */
export function literalRefusal(ts: TS, node: ts.Node): string | null;

/** Compare one file's two versions. */
export function compareSource(
  ts: TS,
  path: string,
  before: string,
  after: string
): { refusal?: string; changes?: TextChange[] };

/** The whole decision for `base..head` in the repository at `cwd`. */
export function classify(
  ts: TS,
  base: string,
  head: string,
  options?: { cwd?: string; pattern?: string }
): Decision;

/** The decision as GitHub step outputs, one `key=value` per line. */
export function toOutputs(decision: Decision): string;
