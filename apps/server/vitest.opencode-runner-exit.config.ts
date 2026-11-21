/** One nested fixture, using the maintained server config and startup chain. */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import server from './vitest.config.js';
const root = fileURLToPath(new URL('./', import.meta.url));
const setups = server.test?.globalSetup;
const custody = 'src/services/runtimes/opencode/__tests__/custody/global-setup.ts';
if (!Array.isArray(setups) || setups.filter((entry) => entry === custody).length !== 1)
  throw new Error('Expected the maintained server startup list');
export default defineConfig({
  ...server,
  root,
  test: {
    ...server.test,
    include: [
      'src/services/runtimes/opencode/__tests__/custody/fixtures/runner-parent-exit.worker.fixture.ts',
    ],
    globalSetup: setups.map((entry) =>
      resolve(
        root,
        entry === custody
          ? 'src/services/runtimes/opencode/__tests__/custody/fixtures/runner-parent-exit.setup.ts'
          : entry
      )
    ),
  },
});
