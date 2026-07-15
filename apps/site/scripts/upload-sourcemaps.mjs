/**
 * Upload the production build's browser source maps to PostHog, then delete
 * them from the shipped output.
 *
 * Runs AFTER `next build` (see the "build" script in package.json), on the
 * emitted `.next/static` output. We use the standalone `@posthog/cli` here
 * instead of the `@posthog/nextjs-config` build wrapper on purpose: Next.js 16
 * defaults to Turbopack, and the wrapper runs inside the build lifecycle where
 * it has open Turbopack failures that can break the deploy. This script runs
 * on the finished output, so a PostHog hiccup can never fail the compile.
 *
 * What it does:
 *   1. Inject a PostHog chunk id into each browser chunk, then upload the maps
 *      so minified production stack traces resolve back to the original TS/TSX
 *      in PostHog error tracking. This step is best-effort: any failure is
 *      logged and swallowed so the build still succeeds. On the success path
 *      the CLI also strips the `//# sourceMappingURL=` comments (via
 *      `--delete-after`), leaving the injected `//# chunkId=` comments intact.
 *   2. ALWAYS delete every leftover source map (`*.js.map`, `*.css.map`, any
 *      `*.map`) under `.next/static`. The site's next.config.ts sets
 *      `productionBrowserSourceMaps: true`, so every build emits browser maps
 *      into `.next/static`; shipping them would leak readable source, so this
 *      cleanup is mandatory and runs on EVERY path (upload, skip, or failure).
 *      A deletion failure is the one condition that fails this script (exit 1),
 *      because it means source maps might still ship.
 *
 * Upload guards (the deletion above always runs; only the upload is gated):
 *   - No POSTHOG_PERSONAL_API_KEY: skip the upload (the normal local `next
 *     build`), then still delete the maps. The build never fails on a missing
 *     key.
 *   - VERCEL_ENV === 'preview': skip the upload (we don't want preview deploys
 *     adding release noise), then still delete the maps.
 *
 * Dependency-free by design: Node built-ins plus the PostHog CLI binary only.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const siteDir = join(scriptDir, '..');
const staticDir = join(siteDir, '.next', 'static');

// The PostHog CLI app host — the human-facing host, NOT the ingest host in
// NEXT_PUBLIC_POSTHOG_HOST (us.i.posthog.com), which the CLI does not accept.
const POSTHOG_CLI_HOST = 'https://us.posthog.com';
// A stable release name so every deploy's chunks land under one project.
// The release version (below) is what distinguishes individual deploys.
const RELEASE_NAME = 'dorkos-site';

/**
 * Recursively collect every source-map file under a directory whose name ends
 * with the given suffix. Use `.js.map` for the JS maps the CLI uploads, and the
 * broader `.map` for the mandatory safety-net deletion (which must remove any
 * source map of any kind: `.js.map`, `.css.map`, etc.).
 *
 * @param {string} dir - Absolute directory to walk.
 * @param {string} suffix - Filename suffix to match (e.g. `.js.map` or `.map`).
 * @returns {string[]} Absolute paths of the matching source-map files.
 */
function findSourceMaps(dir, suffix) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findSourceMaps(full, suffix));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Resolve the build's release version — a stable id that ties uploaded maps to
 * the deploy that produced them. Prefers Vercel's commit SHA, falls back to the
 * local git HEAD, and returns undefined if neither is available (the CLI then
 * auto-derives one from git).
 *
 * @returns {string | undefined} The release version, or undefined.
 */
function resolveReleaseVersion() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: siteDir, encoding: 'utf8' });
  if (git.status === 0 && git.stdout) return git.stdout.trim();
  return undefined;
}

/**
 * Resolve the PostHog CLI binary. Prefers the workspace-local `.bin` entry so
 * the script works whether or not `node_modules/.bin` is on PATH, and falls
 * back to a bare `posthog-cli` lookup on PATH.
 *
 * @returns {string} Path or command name for the CLI.
 */
function resolveCliBin() {
  const local = join(siteDir, 'node_modules', '.bin', 'posthog-cli');
  return existsSync(local) ? local : 'posthog-cli';
}

/**
 * Run one PostHog CLI `sourcemap` subcommand with the release identity and the
 * credentials mapped into the child env.
 *
 * @param {string} bin - The CLI binary path.
 * @param {string} subcommand - `inject` or `upload`.
 * @param {string | undefined} version - The release version, if known.
 * @returns {import('node:child_process').SpawnSyncReturns<Buffer>} Spawn result.
 */
function runSourcemapStep(bin, subcommand, version) {
  const args = ['sourcemap', subcommand, '--directory', staticDir, '--release-name', RELEASE_NAME];
  if (version) args.push('--release-version', version);
  // On the success path, let the CLI clean up: it deletes the uploaded maps and
  // strips the now-dangling `//# sourceMappingURL=` comments (it leaves the
  // injected `//# chunkId=` comments intact, which PostHog needs at runtime).
  // The mandatory `finally` deletion below remains the safety net for the
  // failure/skip paths, where this flag never runs.
  if (subcommand === 'upload') args.push('--delete-after');
  return spawnSync(bin, args, {
    cwd: siteDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      // Map our Vercel-provided vars onto the names the CLI honors, so no new
      // Vercel env vars are needed. Confirmed from the CLI binary: it reads
      // POSTHOG_CLI_API_KEY, POSTHOG_CLI_PROJECT_ID, and POSTHOG_CLI_HOST.
      POSTHOG_CLI_API_KEY: process.env.POSTHOG_PERSONAL_API_KEY,
      POSTHOG_CLI_PROJECT_ID: process.env.POSTHOG_PROJECT_ID ?? '315668',
      POSTHOG_CLI_HOST,
    },
  });
}

const hasKey = Boolean(process.env.POSTHOG_PERSONAL_API_KEY);
const isPreview = process.env.VERCEL_ENV === 'preview';
const version = resolveReleaseVersion();
let deletionFailed = false;

try {
  if (!hasKey) {
    console.log(
      '[sourcemaps] skipped upload: no POSTHOG_PERSONAL_API_KEY (maps still deleted below)'
    );
  } else if (isPreview) {
    console.log('[sourcemaps] skipped upload: VERCEL_ENV=preview (maps still deleted below)');
  } else {
    const bin = resolveCliBin();
    const mapCount = findSourceMaps(staticDir, '.js.map').length;
    if (mapCount === 0) {
      // Sanity check: a production build with productionBrowserSourceMaps:true
      // must emit JS maps here. Zero means Next moved the output and this script
      // is silently uploading nothing.
      console.warn(
        '[sourcemaps] WARNING: no *.js.map found under .next/static — expected browser maps from productionBrowserSourceMaps:true; the output layout may have changed and nothing will be uploaded'
      );
    }
    const inject = runSourcemapStep(bin, 'inject', version);
    if (inject.status !== 0) {
      throw new Error(`posthog-cli sourcemap inject exited with code ${inject.status ?? 'null'}`);
    }
    const upload = runSourcemapStep(bin, 'upload', version);
    if (upload.status !== 0) {
      throw new Error(`posthog-cli sourcemap upload exited with code ${upload.status ?? 'null'}`);
    }
    console.log(`[sourcemaps] uploaded ${mapCount} maps for ${version ?? 'auto-derived release'}`);
  }
} catch (error) {
  // Best-effort: an upload failure must never break the deploy (that is why we
  // run the CLI on the finished output instead of inside the build). But this
  // branch is only reachable when a key WAS present and we tried, so it is the
  // known most-likely silent failure (e.g. the key lacks the
  // `error tracking: write` scope). Make it shout in the Vercel logs.
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `[sourcemaps] WARNING: upload FAILED — PostHog will NOT symbolicate this deploy's errors (check the key's error-tracking:write scope): ${message}`
  );
} finally {
  // Mandatory: strip EVERY source map from the shipped output (`.js.map`,
  // `.css.map`, any `*.map`) even if the upload was skipped or failed. Leaving
  // any of them is a source leak.
  try {
    const maps = findSourceMaps(staticDir, '.map');
    for (const map of maps) rmSync(map);
    console.log(`[sourcemaps] deleted ${maps.length} .map files`);
  } catch (error) {
    // A deletion failure is the one genuine problem: source maps may still
    // ship. Surface it with a non-zero exit.
    console.error(
      `[sourcemaps] FAILED to delete source maps (possible source leak): ${error instanceof Error ? error.message : error}`
    );
    deletionFailed = true;
  }
}

process.exit(deletionFailed ? 1 : 0);
