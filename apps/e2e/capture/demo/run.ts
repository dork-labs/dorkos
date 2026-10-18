import { bootStack, buildServerDeps, preflightStack } from '../boot.js';
import { CLIENT_URL, SHARD_INDEX } from '../config.js';
import { DEMO_FAKE_HOME, DEMO_SHARD, marketingRepoPath } from './config.js';
import { prepareFakeHome, prepareSocialQueue, seedDemo, type DemoSeeds } from './seed.js';
import { warmUp } from './warmup.js';
import { prepareFilesystem, seedData } from '../seed.js';

/**
 * The demo workspace: a seeded DorkOS the video team records against, kept
 * running until Ctrl-C.
 *
 * Every run wipes the demo home and seeds it again, so every recording starts
 * from the same state. It is the capture stack (`../boot.ts`, `../seed.ts`) on its
 * own shard slot, plus the four video flows (`seed.ts` here), with the server
 * given an empty home of its own so nothing from the real `~/.dork`,
 * `~/.claude` or `~/.codex` can reach it.
 *
 * Run with: `pnpm --filter @dorkos/e2e demo`.
 *
 * @module capture/demo/run
 */

/** Where each flow starts, as label and link. */
function flowLinks(seeds: DemoSeeds): [string, string][] {
  return [
    ...(seeds.socialQueue
      ? [['Social queue', `${CLIENT_URL}/x/social-queue`] as [string, string]]
      : []),
    ['#team morning', `${CLIENT_URL}/channels?id=${seeds.teamRoomId}`],
    ['Phone approval', `${CLIENT_URL}/session?session=${seeds.approvalSessionId}`],
    ['Mini app', `${CLIENT_URL}/session?session=${seeds.miniAppSessionId}`],
  ];
}

/** Print where each flow starts. */
function printLinks(seeds: DemoSeeds): void {
  const rows = flowLinks(seeds).map(([label, link]) => `  ${label.padEnd(16)} ${link}`);
  if (!seeds.socialQueue) {
    rows.unshift(
      '  Social queue     skipped: no dorkos-marketing checkout (set DEMO_MARKETING_REPO)'
    );
  }
  process.stdout.write(
    `\n✓ DorkOS demo is up: ${CLIENT_URL}\n\n${rows.join('\n')}\n\n` +
      'Open the phone approval at phone size. The mini app waits under "Needs you" (top right).\n' +
      'Press Ctrl-C to stop. The next run starts fresh.\n'
  );
}

async function main(): Promise<void> {
  if (SHARD_INDEX !== DEMO_SHARD) {
    throw new Error(
      `Run the demo with \`pnpm --filter @dorkos/e2e demo\`: it needs CAPTURE_SHARD=${DEMO_SHARD}, ` +
        'so it never wipes a capture run’s home.'
    );
  }
  // Reconcile a stack a crashed demo left behind, BEFORE the wipe below
  // deletes the pidfile that names it.
  await preflightStack();

  process.stdout.write('▸ Preparing the demo home…\n');
  await prepareFilesystem();
  await prepareFakeHome();
  const socialQueue = await prepareSocialQueue(marketingRepoPath());

  process.stdout.write('▸ Building server deps…\n');
  await buildServerDeps();
  process.stdout.write('▸ Booting…\n');
  const stack = await bootStack({ isolatedHome: DEMO_FAKE_HOME });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    process.stdout.write('\n▸ Stopping…\n');
    void stack.teardown().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    process.stdout.write('▸ Seeding…\n');
    await seedData();
    const seeds = await seedDemo(socialQueue);
    process.stdout.write('▸ Warming up the pages…\n');
    await warmUp([CLIENT_URL, ...flowLinks(seeds).map(([, link]) => link)]);
    printLinks(seeds);
  } catch (err) {
    await stack.teardown();
    throw err;
  }
  // Stay up until a signal: an interval keeps the event loop alive.
  setInterval(() => {}, 60_000);
}

main().catch((err) => {
  process.stderr.write(`Demo failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
