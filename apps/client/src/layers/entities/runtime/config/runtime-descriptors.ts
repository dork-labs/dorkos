/**
 * Runtime visual-identity registry — the single source of truth for every
 * runtime's icon, label, and accent color. Every badge, picker, chip, and
 * session-list mark derives its rendering from {@link getRuntimeDescriptor}
 * so a runtime looks identical everywhere.
 *
 * @module entities/runtime/config
 */
import type { ComponentType } from 'react';
import { FlaskConical } from 'lucide-react';
import {
  AnthropicLogo,
  CodexLogo,
  OpenCodeLogo,
  DefaultAdapterIcon,
} from '@dorkos/icons/adapter-logos';

/**
 * Static setup guidance for a runtime that is not registered with the server.
 *
 * When a runtime IS registered, its live `DependencyCheck.installHint` from
 * `checkDependencies()` is authoritative — this hint only covers the case
 * where no server-side data exists (the runtime is disabled or unknown to
 * this server), so the "Add a runtime" panel still has something honest to
 * show. The commands mirror the server adapters' installHint copy.
 */
export interface RuntimeSetupHint {
  /** Copyable shell command that installs the CLI and signs in. */
  installCommand: string;
  /** Docs URL for manual setup. */
  infoUrl?: string;
}

/** Visual identity for one agent runtime. */
export interface RuntimeDescriptor {
  /** Runtime type identifier, e.g. `'claude-code'` — matches `AgentRuntime.type`. */
  type: string;
  /** Human-readable display name, e.g. `'Claude Code'`. */
  label: string;
  /** Icon component. Renders at 16px by default; pass `size` to override. */
  icon: ComponentType<{ size?: number; className?: string }>;
  /** Accent color as a CSS color value (theme `--color-*` variable). */
  accent: string;
  /**
   * Present only for runtimes a user can ADD to a DorkOS install (OpenCode,
   * Codex). Drives the picker's "Add a runtime" entry point; absent for the
   * built-in default and dev-only runtimes.
   */
  setup?: RuntimeSetupHint;
}

/**
 * Descriptors for every known runtime type.
 *
 * Prefer {@link getRuntimeDescriptor} for lookups — it never returns
 * `undefined`. Read this map directly only to enumerate known runtimes.
 */
export const RUNTIME_DESCRIPTORS: Record<string, RuntimeDescriptor> = {
  'claude-code': {
    type: 'claude-code',
    label: 'Claude Code',
    icon: AnthropicLogo,
    accent: 'var(--color-orange-500)',
  },
  opencode: {
    type: 'opencode',
    label: 'OpenCode',
    icon: OpenCodeLogo,
    accent: 'var(--color-violet-500)',
    setup: {
      installCommand: 'npm i -g opencode-ai && opencode auth login',
      infoUrl: 'https://opencode.ai/docs/server',
    },
  },
  codex: {
    type: 'codex',
    label: 'Codex',
    icon: CodexLogo,
    accent: 'var(--color-teal-500)',
    setup: {
      installCommand: 'npm i -g @openai/codex && codex login',
      infoUrl: 'https://developers.openai.com/codex',
    },
  },
  'test-mode': {
    type: 'test-mode',
    label: 'Test Mode',
    icon: FlaskConical,
    accent: 'var(--color-amber-500)',
  },
};

/**
 * Resolve the visual identity for a runtime type.
 *
 * Unknown types get a neutral fallback (generic icon, the raw type as label)
 * — this never throws and never renders blank, so new or third-party runtimes
 * degrade gracefully everywhere at once.
 *
 * @param type - Runtime type identifier, e.g. `'opencode'`
 */
export function getRuntimeDescriptor(type: string): RuntimeDescriptor {
  return (
    RUNTIME_DESCRIPTORS[type] ?? {
      type,
      label: type,
      icon: DefaultAdapterIcon,
      accent: 'var(--color-muted-foreground)',
    }
  );
}
