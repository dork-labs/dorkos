import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: [
    './src/schema/a2a.ts',
    './src/schema/pulse.ts',
    './src/schema/relay.ts',
    './src/schema/mesh.ts',
  ],
  out: './drizzle',
  dialect: 'sqlite',
});
