/**
 * The Team view's pure rules: sort order, the amber limits and their words, and
 * the count beside a name.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTeamRows,
  formatRunningFor,
  teamBoardFigures,
  teamRowCount,
  unclaimedChats,
  type TeamBoardAgent,
  type TeamBoardChat,
} from '../model/team-board';

const GB = 1024 ** 3;

const agent = (name: string): TeamBoardAgent => ({
  id: name,
  name,
  color: '#000',
  emoji: '🤖',
  projectPath: `/work/${name}`,
});

const chat = (id: string, owner: string, waiting = false): TeamBoardChat => ({
  id,
  cwd: `/work/${owner}`,
  title: id,
  activity: 'Working',
  waiting,
  startedAt: null,
});

describe('buildTeamRows', () => {
  it('sorts needs you, then running, then idle, by name within each', () => {
    const rows = buildTeamRows(
      [agent('idle'), agent('bravo'), agent('alpha'), agent('needs')],
      [chat('1', 'bravo'), chat('2', 'alpha'), chat('3', 'needs', true)]
    );
    expect(rows.map((row) => row.agent.name)).toEqual(['needs', 'alpha', 'bravo', 'idle']);
  });

  it('counts running and waiting apart, and lists waiting chats first', () => {
    const [row] = buildTeamRows(
      [agent('a')],
      [chat('run', 'a'), chat('ask', 'a', true), chat('run2', 'a')]
    );
    expect(row).toMatchObject({ running: 2, waiting: 1 });
    expect(row?.chats.map((c) => c.id)).toEqual(['ask', 'run', 'run2']);
  });
});

describe('unclaimedChats', () => {
  it('keeps a chat in no agent folder, so the total matches the rows', () => {
    const others = unclaimedChats([agent('a')], [chat('mine', 'a'), chat('spare', 'worktree')]);
    expect(others.map((c) => c.id)).toEqual(['spare']);
  });
});

describe('teamBoardFigures', () => {
  const under = { maxAgentChats: 14, loadAverage: 7.2, freeDiskBytes: 24 * GB };

  it('reads as plain numbers under every limit', () => {
    const figures = teamBoardFigures(9, under);
    expect(figures.map((f) => f.text)).toEqual(['9 of 14 chats running', 'load 7', '24 GB free']);
    expect(figures.some((f) => f.over)).toBe(false);
  });

  it('flags the chat count at the cap and says so in words', () => {
    const [chats] = teamBoardFigures(14, under);
    expect(chats).toMatchObject({ text: '14 of 14 chats running, at the limit', over: true });
  });

  it('flags load at 16, not below it', () => {
    expect(teamBoardFigures(1, { ...under, loadAverage: 15.9 })[1]?.over).toBe(false);
    expect(teamBoardFigures(1, { ...under, loadAverage: 16 })[1]).toMatchObject({
      text: 'load 16, limit 16',
      over: true,
    });
  });

  it('flags disk under 20 GB, not at it', () => {
    expect(teamBoardFigures(1, { ...under, freeDiskBytes: 20 * GB })[2]?.over).toBe(false);
    expect(teamBoardFigures(1, { ...under, freeDiskBytes: 12 * GB })[2]).toMatchObject({
      text: '12 GB free, limit 20 GB',
      over: true,
    });
  });

  it('leaves out what the server could not read', () => {
    const figures = teamBoardFigures(2, {
      maxAgentChats: null,
      loadAverage: null,
      freeDiskBytes: null,
    });
    expect(figures.map((f) => f.text)).toEqual(['2 chats running']);
  });
});

describe('teamRowCount', () => {
  it('says only what is true of the agent', () => {
    expect(teamRowCount({ running: 3, waiting: 1 })).toBe('3 running · 1 waiting on you');
    expect(teamRowCount({ running: 0, waiting: 1 })).toBe('1 waiting on you');
    expect(teamRowCount({ running: 0, waiting: 0 })).toBe('Idle');
  });
});

describe('formatRunningFor', () => {
  it('uses the largest units that matter', () => {
    expect(formatRunningFor(45_000)).toBe('45s');
    expect(formatRunningFor(12 * 60_000)).toBe('12m');
    expect(formatRunningFor(125 * 60_000)).toBe('2h 5m');
  });
});
