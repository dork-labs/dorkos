/**
 * The entry `apps/desktop/scripts/build-server.ts` bundles as `dist/cli/dorkos.mjs`:
 * run one command and exit with its code (DOR-3105).
 *
 * @module desktop/terminal-command-main
 */
import { runTerminalCommand } from './terminal-command.js';

void runTerminalCommand(process.argv.slice(2)).then((code) => process.exit(code));
