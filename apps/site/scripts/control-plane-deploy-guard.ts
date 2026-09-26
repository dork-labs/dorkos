/**
 * The one rule about the control-plane migration history: a deploy never runs
 * it.
 *
 * The control-plane tables (accounts, device link, admin, managed connectors)
 * share one database with the DorkOS Cloud control plane, and the control plane
 * owns their schema: it migrates them from its own history, into the same
 * journal table this history uses. Drizzle's migrator applies only the
 * migrations dated after the newest journal row, so when a site deploy ran this
 * history too, a site migration dated later than a pending control-plane one
 * made the control plane skip it.
 *
 * So `pnpm db:migrate`, which every Vercel build runs, applies only the public
 * half, and this guard makes the control-plane half refuse to run inside any
 * Vercel build (production and preview alike) even if somebody wires it back
 * into the build command. `pnpm db:migrate:control-plane` still builds these
 * tables in a local or test database.
 *
 * Deliberately a module of its own with no imports: `drizzle.control-plane.config.ts`
 * calls it, and drizzle-kit loads that config through its own transpiler, where
 * `import.meta` (which `./migration-histories.ts` uses) is not available.
 *
 * @module scripts/control-plane-deploy-guard
 */

/**
 * Throw when this process is a Vercel build or deployment.
 *
 * Vercel sets `VERCEL=1` and `VERCEL_ENV` in every build it runs; either is
 * enough, so a project that stops exposing one of them is still refused. A
 * local `.env` written by `vercel env pull` carries both too, and is refused on
 * purpose: it points at a Vercel-managed database.
 *
 * @param env - The environment to read; defaults to the process's own.
 * @throws Error explaining why the control-plane history does not run here.
 */
export function refuseControlPlaneMigrationOnVercel(
  env: Record<string, string | undefined> = process.env
): void {
  if (!env.VERCEL && !env.VERCEL_ENV) return;
  throw new Error(
    'Refusing to run the control-plane migration history in a Vercel build, or with a ' +
      `Vercel-pulled environment (VERCEL_ENV=${env.VERCEL_ENV ?? 'unset'}). The DorkOS Cloud ` +
      'control plane owns the ' +
      'schema of these tables and migrates them from its own history into the same journal ' +
      'table, so a deploy that migrates them too makes the control plane skip its own ' +
      'migrations. `pnpm db:migrate` applies only the public half; ' +
      '`pnpm db:migrate:control-plane` is for a local or test database.'
  );
}
