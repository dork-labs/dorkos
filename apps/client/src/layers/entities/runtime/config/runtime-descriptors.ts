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
  },
  codex: {
    type: 'codex',
    label: 'Codex',
    icon: CodexLogo,
    accent: 'var(--color-teal-500)',
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
