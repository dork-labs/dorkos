import { readClaudeAccountSettings } from '@dorkos/shared/config-schema';
import { configManager } from '../../core/config-manager.js';
import {
  expandClaudeAccountHome,
  machineDefaultClaudeRoot,
} from '../claude-code/claude-config-dir.js';

/** Server-owned registry metadata only: never stat or walk an account folder. */
export function signinAccounts(): Array<{ accountId: string; path: string; name: string }> {
  let block: unknown;
  try {
    block = configManager.get('runtimes')?.claudeCode;
  } catch {
    return [];
  }
  const read = readClaudeAccountSettings(block);
  const rows = read.accounts.map((row) => ({
    accountId: row.id,
    path: expandClaudeAccountHome(row.path),
    name: row.label ?? row.id,
  }));
  const root = machineDefaultClaudeRoot();
  if (!rows.some((row) => row.path === root))
    rows.push({ accountId: 'default', path: root, name: 'Main' });
  return rows;
}
