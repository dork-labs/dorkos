/**
 * DOR-4315: only the task's own agent, in its own unmarked chat, sets a list
 * with no card. Each condition on its own, the same-home check included, so
 * none of them rests on another layer to be caught. Made-up homes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentModeCaller } from '../../../../tasks/agent-mode/agent-mode-decision.js';
import { ownChatOwnTask } from '../tasks/task-tool-allow-list.js';

let root: string;
let homeA: string;
let homeB: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dor4315-owner-')));
  homeA = path.join(root, 'agent-a');
  homeB = path.join(root, 'agent-b');
  fs.mkdirSync(homeA);
  fs.mkdirSync(homeB);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Agent A in its own chat, unmarked, resolved by its home. */
function callerA(overrides: Partial<AgentModeCaller> = {}): AgentModeCaller {
  return { structural: true, agentPath: homeA, resolved: 'home', marked: false, ...overrides };
}

describe('ownChatOwnTask', () => {
  it('is true for the task’s own agent in its own unmarked chat', () => {
    expect(ownChatOwnTask(callerA(), homeA)).toBe(true);
  });

  it('is false for another agent’s task, everything else equal', () => {
    expect(ownChatOwnTask(callerA(), homeB)).toBe(false);
  });

  it('is false when DorkOS can’t name the task’s agent', () => {
    expect(ownChatOwnTask(callerA(), undefined)).toBe(false);
  });

  it('is true for the same home spelled through a link', () => {
    const link = path.join(root, 'link-to-a');
    fs.symlinkSync(homeA, link);
    expect(ownChatOwnTask(callerA(), link)).toBe(true);
  });

  it.each([
    ['a turn that read outside words', { marked: true }],
    ['a caller that is not one of our own tools', { structural: false }],
    ['an identity a linked worktree claims', { resolved: 'worktree' as const }],
    ['an identity only a dispatch named', { resolved: 'dispatched' as const }],
    ['an identity from a token', { resolved: 'token' as const }],
    ['a caller with no home', { agentPath: undefined }],
  ])('is false for %s', (_label, overrides) => {
    expect(ownChatOwnTask(callerA(overrides), homeA)).toBe(false);
  });
});
