import { vi } from 'vitest';

const { query } = vi.hoisted(() => ({
  query: vi.fn(() => {
    throw new Error('Cold settings must not open a Claude query');
  }),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query,
}));

/** The query stub used by the mounted cold-settings fixture. */
export function coldSettingsQuery() {
  return query;
}
