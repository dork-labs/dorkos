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
 * When a runtime IS registered, its live per-check `DependencyCheck.installHint`
 * from `checkDependencies()` is authoritative (install-only vs auth-only) — this
 * hint only covers the case where no server-side data exists (the runtime is
 * disabled or unknown to this server), so the "Add a runtime" panel still has
 * something honest to show. It is **install-only** (get the binary): auth is a
 * separate step that only becomes actionable once the runtime is registered, so
 * this never bundles a `… && … login` combined command.
 */
export interface RuntimeSetupHint {
  /** Copyable shell command that installs the CLI (binary only, no auth step). */
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
      installCommand: 'npm i -g opencode-ai',
      infoUrl: 'https://opencode.ai/docs/server',
    },
  },
  codex: {
    type: 'codex',
    label: 'Codex',
    icon: CodexLogo,
    accent: 'var(--color-teal-500)',
    setup: {
      installCommand: 'npm i -g @openai/codex',
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
 * The canonical, user-facing runtimes presented as siblings on the setup and
 * discovery surfaces, in display order. These three are DorkOS's product
 * runtimes; the overview shows each as Ready-or-one-Connect so a Claude-only
 * user discovers DorkOS also speaks Codex and OpenCode. Excludes the dev-only
 * `test-mode` runtime (an e2e artifact, never a user-facing choice).
 */
export const PRIMARY_RUNTIME_TYPES = ['claude-code', 'codex', 'opencode'] as const;

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
