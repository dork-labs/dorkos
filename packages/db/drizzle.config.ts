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
    // Historical inputs keep generated SQL from dropping rows before application backfill.
    './src/schema/connected-accounts.ts',
    './src/schema/connector-attachments.ts',
    // Live schema split out so runtime consumers never load the historical declarations above.
    './src/schema/unclaimed-chats.ts',
    './src/schema/connectors/connections.ts',
    './src/schema/connectors/connector-events.ts',
    './src/schema/connectors/connector-review-requests.ts',
    './src/schema/connectors/connector-usage.ts',
    './src/schema/connectors/connector-execution-state.ts',
    './src/schema/connectors/connector-local-state.ts',
    './src/schema/rooms.ts',
    './src/schema/room-coordination.ts',
    './src/schema/read-cursors.ts',
    './src/schema/bridges.ts',
    './src/schema/search.ts',
    './src/schema/notifications.ts',
  ],
  out: './drizzle',
  dialect: 'sqlite',
});
