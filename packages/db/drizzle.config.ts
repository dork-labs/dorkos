import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: [
    './src/schema/a2a.ts',
    './src/schema/activity.ts',
    './src/schema/approvals.ts',
    './src/schema/approval-grants.ts',
    './src/schema/agent-identity.ts',
    './src/schema/tasks.ts',
    './src/schema/relay.ts',
    './src/schema/mesh.ts',
    './src/schema/sessions.ts',
    './src/schema/codex.ts',
    './src/schema/opencode.ts',
    './src/schema/session-events.ts',
    './src/schema/workspace.ts',
    './src/schema/auth.ts',
    './src/schema/connected-accounts.ts',
    './src/schema/connector-attachments.ts',
    './src/schema/rooms.ts',
    './src/schema/read-cursors.ts',
    './src/schema/bridges.ts',
    './src/schema/search.ts',
  ],
  out: './drizzle',
  dialect: 'sqlite',
});
