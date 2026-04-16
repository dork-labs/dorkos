import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: [
    './src/schema/a2a.ts',
    './src/schema/activity.ts',
    './src/schema/tasks.ts',
    './src/schema/relay.ts',
    './src/schema/mesh.ts',
    './src/schema/sessions.ts',
  ],
  out: './drizzle',
  dialect: 'sqlite',
});
