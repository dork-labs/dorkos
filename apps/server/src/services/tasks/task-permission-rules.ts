/**
 * The server's own check on rules proposed or approved for one scheduled task
 * (DOR-3637, review of #3794). The shared schema already refuses a rule that
 * names no specific action; this adds what only the server knows: the person's
 * real home folder, and which runtime the task's runs start on.
 *
 * @module services/tasks/task-permission-rules
 */
import { isSpecificPermissionRule } from '@dorkos/shared/permission-rules';
import { expandTilde } from '../../lib/boundary.js';
import { runtimeRegistry } from '../core/runtime-registry.js';

/** A refusal for a proposal or approval whose rules cannot be honoured. */
export interface TaskPermissionRulesRefusal {
  /** What to tell the caller. */
  error: string;
  /** Machine-readable reason. */
  code: 'task_rules_unsupported_runtime' | 'task_rule_too_broad';
}

/**
 * The one runtime whose launches apply a task's own rules. Only the Claude Code
 * launch merges them into that run's settings, beside the protected-path denies
 * (`folder-settings/launch-folder-allows.ts`). Codex and OpenCode have no
 * per-launch allow list to put them in, so rules for them would be shown and
 * approved yet do nothing; they are refused instead (fail closed). An explicit
 * id rather than a capability flag: no runtime capability says "applies
 * per-launch allow rules" today, and #3788's `protectedPaths` guard describes
 * the denies, not this.
 */
const RULES_RUNTIME = 'claude-code';

/**
 * Refuse rules the task's runs could not honour, or that reach the whole home
 * folder by its absolute path. Nothing to check when there are no rules.
 *
 * @param input - The task's runtime (null for the default) and its rules.
 */
export function taskPermissionRulesRefusal(input: {
  runtime: string | null | undefined;
  rules: readonly string[];
}): TaskPermissionRulesRefusal | null {
  if (input.rules.length === 0) return null;
  const runtime = input.runtime ?? runtimeRegistry.getDefaultType();
  if (runtime !== RULES_RUNTIME) {
    return {
      error: 'Task rules only work for Claude Code runs. Leave them off for this runtime.',
      code: 'task_rules_unsupported_runtime',
    };
  }
  // The `~` a person means, resolved the way the boundary resolves it (Hard Rule 3).
  const home = expandTilde('~');
  const broad = input.rules.find((rule) => !isSpecificPermissionRule(rule, { home }));
  return broad
    ? {
        error: `"${broad}" covers your whole home folder. Name one file or command.`,
        code: 'task_rule_too_broad',
      }
    : null;
}
