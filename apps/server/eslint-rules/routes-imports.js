/**
 * Routes stay thin (DOR-4923, `.claude/rules/api.md`): a file under `src/routes/` validates the
 * request, calls a service and maps its answer. So it never imports the database (`@dorkos/db`,
 * `drizzle-orm`), the filesystem (`fs`, `node:fs`, either `/promises`) or a concrete runtime adapter
 * (`services/runtimes/{claude-code,codex,opencode,doe}/`). Types count too: a route that names
 * `Db` is holding the database, so it takes the service's bound store instead.
 *
 * The database ban has no exceptions. The other two have a list each of the route files that
 * still import the thing, and **each list only shrinks**: never add a file. A route that needs
 * the filesystem or one runtime's own code calls a service that has it. When a listed file stops
 * importing the thing, take it off the list; `src/__tests__/routes-imports-lint.test.ts` fails
 * while a listed file no longer needs its entry.
 *
 * `no-restricted-imports` options replace rather than merge, so these blocks restate the
 * server-wide bans they are handed (`ALL_CONFINED` and the homedir import ban). Tests are not
 * checked: they set up the database and files a route reads.
 */

/** Paths are relative to the server package, as ESLint matches them. */
const ROUTES = 'src/routes';

/**
 * Route files that still import `fs` or `node:fs` (or `/promises`). Only shrinks: move the file
 * work into a service, then delete the line.
 */
export const FS_ALLOWED = [
  'src/routes/admin.ts',
  'src/routes/agents.ts',
  'src/routes/debug.ts',
  'src/routes/directory.ts',
  'src/routes/extensions-prefs.ts',
  'src/routes/extensions.ts',
  'src/routes/file-entries.ts',
  'src/routes/files.ts',
  'src/routes/harness.ts',
  'src/routes/marketplace/packages.ts',
  'src/routes/mesh-agent-patch-http.ts',
  'src/routes/room-canvas.ts',
  'src/routes/session-recording.ts',
  'src/routes/test-control.ts',
  'src/routes/workbench-serve.ts',
];

/**
 * Route files that still import a concrete runtime adapter. Only shrinks. Not fixed one by one:
 * step 6 of the computer side starting alone (`specs/computer-side-starts-alone`, DOR-5152)
 * changes how a route reaches a runtime, and these move with it.
 */
export const RUNTIME_ALLOWED = [
  'src/routes/account-signin.ts',
  'src/routes/agents.ts',
  'src/routes/config.ts',
  'src/routes/mesh-agent-patch-http.ts',
  'src/routes/onboarding.ts',
  'src/routes/relay-binding-step-up.ts',
  'src/routes/runtime-settings-reader.ts',
  'src/routes/runtimes-account-eligibility.ts',
  'src/routes/runtimes.ts',
  'src/routes/sessions.ts',
  'src/routes/system-shell-check.ts',
  'src/routes/task-approval-rules.ts',
];

/** `@dorkos/db` and its subpaths. */
export const DB_BAN = {
  regex: '^@dorkos/db(?:/.*)?$',
  message:
    'Routes never touch the database (DOR-4923). Put the query in the service that owns the data, behind a named function, and call that.',
};
/** `drizzle-orm` and its subpaths. */
export const DRIZZLE_BAN = {
  regex: '^drizzle-orm(?:/.*)?$',
  message:
    'Routes never build a query (DOR-4923). Put it in the service that owns the data, behind a named function, and call that.',
};
/** `fs`, `node:fs` and both `/promises`. */
export const FS_BAN = {
  regex: '^(?:node:)?fs(?:/promises)?$',
  message:
    'Routes reach files through a service, not fs (DOR-4923). The files that still do are listed in eslint-rules/routes-imports.js; that list only shrinks.',
};
/** Any module inside one runtime's adapter folder. */
export const RUNTIME_BAN = {
  regex: '(?:^|/)services/runtimes/(?:claude-code|codex|opencode|doe)(?:/|$)',
  message:
    'Routes reach a runtime through AgentRuntime and runtimeRegistry, never one adapter (DOR-4923). The files that still do are listed in eslint-rules/routes-imports.js until DOR-5152.',
};

/**
 * The route blocks: every ban for every route file, then one block for each listed file without
 * the ban it is listed for.
 *
 * @param {object[]} patterns - The server-wide pattern bans routes keep.
 * @param {object[]} paths - The server-wide path bans routes keep.
 * @returns {object[]} Flat-config blocks, to spread after the server-wide block.
 */
export function routesImportBlocks(patterns, paths) {
  const every = [...patterns, DB_BAN, DRIZZLE_BAN, FS_BAN, RUNTIME_BAN];
  const rule = (bans) => ({ 'no-restricted-imports': ['error', { patterns: bans, paths }] });
  const listed = [...new Set([...FS_ALLOWED, ...RUNTIME_ALLOWED])].sort();
  return [
    {
      files: [`${ROUTES}/**/*.ts`],
      ignores: [`${ROUTES}/**/__tests__/**`, `${ROUTES}/**/*.test.ts`],
      rules: rule(every),
    },
    ...listed.map((file) => ({
      files: [file],
      rules: rule(
        every.filter(
          (ban) =>
            !(ban === FS_BAN && FS_ALLOWED.includes(file)) &&
            !(ban === RUNTIME_BAN && RUNTIME_ALLOWED.includes(file))
        )
      ),
    })),
  ];
}
