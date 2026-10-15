/** Only nonaccount first-run prompt fields; preserve their exact prelaunch timestamps. */
import assert from 'node:assert/strict';
/** Seed only nonaccount first-run prompts before the first renderer loads. */
export function createPromptSeed() {
  const timestamp = new Date().toISOString();
  return {
    onboarding: { dismissedAt: timestamp },
    profile: { rolePromptDismissedAt: timestamp, identityPromptDismissedAt: timestamp },
    telemetry: { userHasDecided: true },
    ui: { trustNoticeSeenAt: timestamp },
  };
}
/** Verify the exact prelaunch prompt fields and preserve their original timestamps. */
export function assertPromptSeed(
  config: {
    onboarding?: { dismissedAt?: string | null };
    profile?: { rolePromptDismissedAt?: string | null; identityPromptDismissedAt?: string | null };
    telemetry?: { userHasDecided?: boolean };
    ui?: { trustNoticeSeenAt?: string | null };
  },
  expected: ReturnType<typeof createPromptSeed>
) {
  const actual = {
    onboarding: { dismissedAt: config.onboarding?.dismissedAt },
    profile: {
      rolePromptDismissedAt: config.profile?.rolePromptDismissedAt,
      identityPromptDismissedAt: config.profile?.identityPromptDismissedAt,
    },
    telemetry: { userHasDecided: config.telemetry?.userHasDecided },
    ui: { trustNoticeSeenAt: config.ui?.trustNoticeSeenAt },
  };
  assert.deepEqual(actual, expected);
  return actual;
}
