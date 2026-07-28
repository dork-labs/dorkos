import { describe, expect, it } from 'vitest';

// DOR-544 proof-of-life: deliberately failing test to confirm the new `test`
// GitHub Actions workflow actually goes red on a real defect. Removed in the
// follow-up commit once the red run is captured.
describe('DOR-544 CI proof', () => {
  it('deliberately fails to prove the test workflow can go red', () => {
    expect(true).toBe(false);
  });
});
