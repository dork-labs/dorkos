/**
 * A hook card shows the shell command it would install exactly. The stricter
 * sweep a connected-app approval uses (DOR-2504) must never reach this card:
 * a command full of `task-runner`, `Basic` or long ids is the thing a person is
 * deciding on, and hiding it would make the card unanswerable.
 */
import { describe, expect, it } from 'vitest';
import { summariseHookProjection } from '../hook-approval.js';

describe('the hook approval card keeps ordinary commands readable', () => {
  it.each([
    ['npx task-runner-with-a-very-long-name --watch'],
    ['./scripts/desk-booking-for-the-quarterly-planning-offsite.sh'],
    ["curl -H 'Accept: text/plain' --user-agent 'Basic settings'"],
    ['gdrive download 1a2B3c4D5e6F7g8H9i0J-kLmNoPqRsTuVwXyZ_abcd1234'],
    ['echo Zk9Lm2Qx7Rt5Vw8Yz1Ab3Cd4Ef6Gh8Ij0Kl2Mn4Op6'],
    ['git log --oneline -20 && pnpm vitest run apps/server'],
  ])('shows %s as written', (command) => {
    const summary = summariseHookProjection({
      projectPath: '/projects/acme',
      packageName: 'acme-hooks',
      hooks: [{ event: 'Stop', command }],
    });
    expect(summary).toContain(JSON.stringify(command));
  });
});
