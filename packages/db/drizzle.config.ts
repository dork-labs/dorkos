import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: [
    './src/schema/pulse.ts',
    './src/schema/relay.ts',
    './src/schema/mesh.ts',
  ],
  out: './drizzle',
  dialect: 'sqlite',
});
