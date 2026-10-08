import process from 'node:process';
import console from 'node:console';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { URL, pathToFileURL } from 'node:url';

/** Run explicitly against a supplied local Chat Completions endpoint; importing is inert. */
export async function main(argv = process.argv.slice(2)) {
  const [endpoint, modelId, approval] = argv;
  if (!endpoint || !modelId || argv.length > 3 || (approval && approval !== '--allow-tools')) {
    throw new Error(
      'Usage: node examples/local.mjs <loopback-endpoint> <model-id> [--allow-tools]'
    );
  }
  const url = new URL(endpoint);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Supply a loopback HTTP endpoint without credentials, query or fragment.');
  }
  if (!modelId.trim() || modelId.includes('\0')) throw new Error('Supply a model ID.');
  const { Doe, SqliteModelStore, LocalResources, createLocalTools, createDefaultToolRegistry } =
    await import('@dorkos/doe');
  const ownedDirectory = await mkdtemp(join(tmpdir(), 'doe-local-example-'));
  let store, doe, run;
  const interrupted = () => doe?.abort();
  try {
    const workingDirectory = await realpath(ownedDirectory);
    const pathPolicy = { readRoots: [workingDirectory], writeRoots: [workingDirectory] };
    store = new SqliteModelStore(join(workingDirectory, 'history.sqlite'));
    const resources = new LocalResources(
      {
        ancestorDirectories: [workingDirectory],
        skillRoots: [],
        context: 'This is a disposable example workspace. Keep work inside it.',
      },
      pathPolicy,
      workingDirectory
    );
    const registry = createDefaultToolRegistry(
      createLocalTools({ resources, pathPolicy, workingDirectory })
    );
    doe = new Doe({
      sessionId: 'local-example',
      workingDirectory,
      pathPolicy,
      store,
      resources,
      registry,
      model: {
        protocol: 'openai-completions',
        endpoint: url.href,
        id: modelId,
        contextWindow: 32768,
        maxOutputTokens: 2048,
        payer: 'local-example',
        historyFamily: 'openai-completions',
        requiresCredentials: false,
        credentials: async () => undefined,
      },
      approve: async () => (approval === '--allow-tools' ? 'allow' : 'deny'),
      onEvent: (event) => {
        if (event.type === 'text' && event.scope === 'main') process.stdout.write(event.delta);
      },
    });
    process.on('SIGINT', interrupted);
    run = doe.run(
      'Describe a short plan for following up on a customer order. Use tools only if needed.'
    );
    const result = await run;
    process.stdout.write('\n');
    console.log('Model request usage (missing counts or cost are unknown):');
    console.log(JSON.stringify(store.allUsage('local-example'), null, 2));
    if (result.stopReason !== 'stop') throw new Error(`Run ended with ${result.stopReason}.`);
    if (result.approvalDenied)
      throw new Error(
        'A tool was denied. Use --allow-tools to approve this example’s workspace tools.'
      );
    return result;
  } finally {
    process.removeListener('SIGINT', interrupted);
    doe?.abort();
    // Await facade-owned child cleanup/accounting before closing its database.
    if (run) await run.catch(() => {});
    try {
      store?.close();
    } finally {
      await rm(ownedDirectory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Local example failed.');
    process.exitCode = 1;
  });
}
