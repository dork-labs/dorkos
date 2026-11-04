import { defineConfig, mergeConfig } from 'vitest/config';
import { loadConfigFromFile } from 'vite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import DurationSequencer from './sequencer.ts';

// Vitest 4 takes a constructor, not a module path, for sequence.sequencer.
// Load each package's real config (including callbacks/plugins), then change
// only the sequencer. A missing/broken package config must still fail loudly.
export default defineConfig(async (env) => {
  const config = resolve(process.cwd(), 'vitest.config.ts');
  // Client and design-system keep test settings in vite.config.ts instead.
  const loaded = await loadConfigFromFile(
    env,
    existsSync(config) ? config : undefined,
    process.cwd()
  );
  if (!loaded) throw new Error('No package Vitest or Vite config found');
  return mergeConfig(loaded.config, { test: { sequence: { sequencer: DurationSequencer } } });
});
