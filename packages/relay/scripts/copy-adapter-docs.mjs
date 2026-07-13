// Copy each adapter's `docs/` folder from src to dist after `tsc`.
//
// Replaces an inline bash `for … do … done` loop in the build script that used
// `sed`/`cp`/`mkdir -p` — none of which run under Windows `cmd.exe`, so the
// package (and therefore any Windows build that depends on it, including the
// desktop app) failed to build. This is plain Node (fs/path only), so it runs
// identically on macOS, Linux, and Windows. Kept dependency-free (no tsx) to
// match apps/server's `node -e` copy step.
import fs from 'node:fs';
import path from 'node:path';

const ADAPTERS_DIR = 'src/adapters';

for (const adapter of fs.readdirSync(ADAPTERS_DIR)) {
  const srcDocs = path.join(ADAPTERS_DIR, adapter, 'docs');
  if (!fs.existsSync(srcDocs)) continue;
  const destDocs = path.join('dist', 'adapters', adapter, 'docs');
  fs.cpSync(srcDocs, destDocs, { recursive: true });
}
