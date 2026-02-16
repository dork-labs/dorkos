import { build } from 'esbuild';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import { readFileSync } from 'fs';
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
  execSync('npx turbo build --filter=@dorkos/client', { cwd: ROOT, stdio: 'inherit' });
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
    sourcemap: true,
    banner: {
      js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    },
  });

  // 3. Compile CLI entry
  console.log('[3/3] Compiling CLI...');
  await build({
    entryPoints: [path.join(ROOT, 'packages/cli/src/cli.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: path.join(OUT, 'bin/cli.js'),
    external: ['dotenv', '../server/index.js', 'conf', '@inquirer/prompts'],
    define: { __CLI_VERSION__: JSON.stringify(version) },
    banner: { js: '#!/usr/bin/env node' },
  });

  // Make executable
  await fs.chmod(path.join(OUT, 'bin/cli.js'), 0o755);

  console.log('Build complete.');
}

buildCLI();
