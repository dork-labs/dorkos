/**
 * Server half of the agent-tools fixture extension (DOR-2685): one tool per
 * tier, bound with `ctx.tools.handle`. Tests load it through the real
 * compiler and lifecycle.
 */
import type { Router } from 'express';
import type { DataProviderContext } from '@dorkos/extension-api/server';

/**
 * Bind a handler to each declared tool.
 *
 * @param _router - The extension's router; this fixture adds no routes.
 * @param ctx - The extension's server context.
 */
export default function register(_router: Router, ctx: DataProviderContext): void {
  let counter = 0;
  ctx.tools.handle('echo', (input) => {
    const { message } = input as { message: string };
    return { message };
  });
  ctx.tools.handle('bump_counter', (input) => {
    const { by } = input as { by: number };
    counter += by;
    return { total: counter };
  });
  ctx.tools.handle('delete_note', (input) => {
    const { noteId } = input as { noteId: string };
    return { deleted: noteId };
  });
}
