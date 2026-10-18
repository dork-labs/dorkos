/**
 * The one-call pass in the teammate tier (DOR-2956): the owner allowed one call, and exactly that
 * call, once, gets through; the store's answer decides whether it is spent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { teammateTierDecision, type TeammateTierScope } from '../teammate-tier.js';
import { askCallHash, setAskOwnerPort, type PassSpend } from '../ask-owner.js';

const CALL = { command: 'git log -1' };

function scope(): TeammateTierScope {
  return {
    roomId: 'room-a',
    sharedFolder: null,
    authorId: 'agent-a',
    asker: { memberId: 'member-bo', displayName: 'Bo' },
    pass: { approvalId: 'appr-1', tool: 'Bash', inputHash: askCallHash('Bash', CALL) },
  };
}

const bash = (input: Record<string, unknown>) =>
  ({ source: 'built-in', name: 'Bash', input }) as const;

/** A port whose store grants a spend once, as a real single-use approval does. */
function grantingOnce() {
  const spends: PassSpend[] = [];
  let left = 1;
  setAskOwnerPort({
    request: vi.fn(),
    spend: (spend) => {
      spends.push(spend);
      return left-- > 0;
    },
  });
  return spends;
}

afterEach(() => setAskOwnerPort(undefined));

describe('the one-call pass', () => {
  it('lets the allowed call through once, spending it with the turn’s own room and teammate', async () => {
    const spends = grantingOnce();
    const s = scope();
    const decision = await teammateTierDecision(s, bash({ ...CALL, description: 'show it' }));
    expect(decision).toEqual({ allowPass: { input: CALL } });
    expect(spends).toEqual([
      {
        approvalId: 'appr-1',
        inputHash: askCallHash('Bash', CALL),
        roomId: 'room-a',
        authorId: 'agent-a',
        memberId: 'member-bo',
      },
    ]);
    expect(s.pass).toBeUndefined();
  });

  it('refuses a second call, the same one included', async () => {
    grantingOnce();
    const s = scope();
    await teammateTierDecision(s, bash(CALL));
    const again = await teammateTierDecision(s, bash(CALL));
    expect(again).toMatchObject({ refuse: expect.any(String) });
  });

  it('refuses the same tool with different input, and keeps the pass for the right call', async () => {
    const spends = grantingOnce();
    const s = scope();
    expect(
      await teammateTierDecision(s, bash({ command: 'git log -1; cat ~/.ssh/id_rsa' }))
    ).toMatchObject({
      refuse: expect.any(String),
    });
    expect(spends).toHaveLength(0);
    expect(s.pass).toBeDefined();
  });

  it('refuses another tool with the same input', async () => {
    grantingOnce();
    const decision = await teammateTierDecision(scope(), {
      source: 'built-in',
      name: 'Write',
      input: CALL,
    });
    expect(decision).toMatchObject({ refuse: expect.any(String) });
  });

  it('refuses the call when the store will not spend it (replayed, expired, denied, elsewhere)', async () => {
    setAskOwnerPort({ request: vi.fn(), spend: () => false });
    const s = scope();
    expect(await teammateTierDecision(s, bash(CALL))).toMatchObject({ refuse: expect.any(String) });
    expect(s.pass).toBeUndefined();
  });

  it('refuses everything when nothing is wired to spend a pass', async () => {
    expect(await teammateTierDecision(scope(), bash(CALL))).toMatchObject({
      refuse: expect.any(String),
    });
  });

  it('matches a copied argument the defused prompt put zero-width spaces in', async () => {
    grantingOnce();
    const s = scope();
    s.pass = {
      approvalId: 'appr-1',
      tool: 'Bash',
      inputHash: askCallHash('Bash', { command: 'echo @x' }),
    };
    const decision = await teammateTierDecision(s, bash({ command: 'echo ​@x' }));
    expect(decision).toEqual({ allowPass: { input: { command: 'echo @x' } } });
  });

  it('lets ask_owner itself through in a teammate’s turn', async () => {
    expect(
      await teammateTierDecision(
        { roomId: 'room-a', sharedFolder: null },
        { source: 'dorkos', name: 'ask_owner', input: {} }
      )
    ).toEqual({ allow: true });
  });
});
