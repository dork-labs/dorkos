import { build } from 'esbuild';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import { cpSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const CLI_PKG = path.resolve(__dirname, '..');
const OUT = path.resolve(CLI_PKG, 'dist');

// Read CLI package version for injection into the binary
const { version } = JSON.parse(readFileSync(path.join(CLI_PKG, 'package.json'), 'utf-8'));

async function buildCLI() {
  // Clean
  await fs.rm(OUT, { recursive: true, force: true });

  // 1. Build client (Vite)
  console.log('[1/3] Building client...');
  execSync('pnpm turbo build --filter=@dorkos/client', { cwd: ROOT, stdio: 'inherit' });
  await fs.cp(path.join(ROOT, 'apps/client/dist'), path.join(OUT, 'client'), { recursive: true });

  // 2. Bundle server (esbuild) — inlines @dorkos/shared, externalizes node_modules
  console.log('[2/3] Bundling server...');
  await build({
    entryPoints: [path.join(ROOT, 'apps/server/src/index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: path.join(OUT, 'server/index.js'),
    external: [
      '@anthropic-ai/claude-agent-sdk',
      '@ngrok/ngrok',
      '@scalar/express-api-reference',
      '@asteasolutions/zod-to-openapi',
      'express',
      'cors',
      'dotenv',
      'gray-matter',
      'uuid',
      'zod',
      'conf',
      '@inquirer/prompts',
    ],
    define: { __CLI_VERSION__: JSON.stringify(version) },
    sourcemap: true,
    banner: {
      js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    },
  });

  // 2.5: Copy Drizzle migration files alongside bundled server.
  // At runtime, runMigrations() resolves migrations via path.join(__dirname, '../../drizzle').
  // In the CLI bundle, __dirname is dist/server/, so ../../drizzle resolves to dist/drizzle/.
  cpSync(
    path.join(ROOT, 'packages/db/drizzle'),
    path.join(OUT, 'drizzle'),
    { recursive: true },
  );
  console.log('  ✓ Copied Drizzle migrations to dist/drizzle/');

  // 3. Compile CLI entry
  // The CLI imports ../server/services/core/config-manager.js which doesn't exist
  // relative to packages/cli/src/. Redirect it to the actual server source.
  console.log('[3/3] Compiling CLI...');
  await build({
    entryPoints: [path.join(ROOT, 'packages/cli/src/cli.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: path.join(OUT, 'bin/cli.js'),
    external: ['dotenv', '../server/index.js', 'conf', '@inquirer/prompts'],
    plugins: [{
      name: 'resolve-server-imports',
      setup(build) {
        build.onResolve({ filter: /\.\.\/server\/services\// }, (args) => {
          // Extract the relative path after ../server/services/ (e.g., "core/config-manager.js")
          const match = args.path.match(/\.\.\/server\/services\/(.+)/);
          if (!match) return undefined;
          const relativePath = match[1].replace(/\.js$/, '.ts');
          return { path: path.join(ROOT, 'apps/server/src/services', relativePath) };
        });
      },
    }],
    define: { __CLI_VERSION__: JSON.stringify(version) },
    banner: { js: '#!/usr/bin/env node' },
  });

  // Make executable
  await fs.chmod(path.join(OUT, 'bin/cli.js'), 0o755);

  console.log('Build complete.');
}

buildCLI();
