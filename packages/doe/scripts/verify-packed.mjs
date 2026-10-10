import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const scripts = fileURLToPath(new URL('./', import.meta.url));
const consumer = await mkdtemp(join(tmpdir(), 'doe-packed-consumer-'));
try {
  // Outside the repository: ancestor workspace dependencies cannot hide a missing dependency.
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({ private: true, type: 'module' })
  );
  const packed = await execute('npm', ['pack', '--json', '--pack-destination', consumer], {
    cwd: packageRoot,
    maxBuffer: 4 * 1024 * 1024,
  });
  const [tarball] = JSON.parse(packed.stdout);
  const files = tarball.files.map((file) => file.path);
  for (const required of [
    'dist/index.js',
    'dist/index.d.ts',
    'README.md',
    'NOTES.md',
    'BUILDER.md',
    'LICENSE',
    'THIRD-PARTY-NOTICES.md',
    'examples/local.mjs',
  ])
    assert(files.includes(required), `Missing packed file: ${required}`);
  assert(
    !files.some(
      (file) => file.startsWith('src/') || file.includes('__tests__') || file.startsWith('scripts/')
    )
  );
  const install = await execute(
    'npm',
    ['install', '--omit=dev', '--no-audit', '--no-fund', join(consumer, tarball.filename)],
    {
      cwd: consumer,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120000,
    }
  );
  assert(install.stdout.includes('package'), 'Production installation did not finish');
  const graph = JSON.parse(
    (
      await execute('npm', ['ls', '--omit=dev', '--all', '--json'], {
        cwd: consumer,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout
  );
  const versions = new Map();
  function inspect(entry) {
    for (const [name, dependency] of Object.entries(entry.dependencies ?? {})) {
      assert(
        !/^@(?:dorkos|dork-labs)\//.test(name) || name === '@dorkos/doe',
        `Product dependency: ${name}`
      );
      versions.set(name, dependency.version);
      inspect(dependency);
    }
  }
  inspect(graph);
  for (const name of ['pi-agent-core', 'pi-ai', 'pi-mcp'])
    assert.equal(versions.get(`@earendil-works/${name}`), '1.0.4');
  for (const filename of ['cold-consumer.mjs', 'check-consumer.mjs'])
    await copyFile(join(scripts, filename), join(consumer, filename));
  await copyFile(
    join(packageRoot, 'src/__tests__/protocol-fixture.ts'),
    join(consumer, 'protocol-fixture.ts')
  );
  const cold = await execute(process.execPath, ['cold-consumer.mjs'], {
    cwd: consumer,
    timeout: 10000,
  });
  process.stdout.write(cold.stdout);
  const wire = await execute(
    process.execPath,
    ['--experimental-strip-types', 'check-consumer.mjs'],
    {
      cwd: consumer,
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    }
  );
  process.stdout.write(wire.stdout);
  console.log(
    JSON.stringify({
      productionPackages: versions.size,
      anthropicSdk: versions.get('@anthropic-ai/sdk'),
      openaiSdk: versions.get('openai'),
      packedFiles: files.length,
    })
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
