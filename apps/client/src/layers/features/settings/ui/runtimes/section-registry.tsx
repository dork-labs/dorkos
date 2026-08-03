/**
 * Renderers for the bespoke settings sections runtimes declare.
 *
 * A runtime card's skeleton is fixed — model, effort, trust, setup details — but
 * *which* boxed sub-sections it carries comes from the runtime itself
 * (`RuntimeCapabilities.settings.sections`). This module is the client half of
 * that contract: it maps a declared `kind` to the feature component that draws
 * it, the same slot pattern `renderRuntimeConnect` already uses for
 * `login` / `provider-picker`.
 *
 * Adding a section is a one-line entry here plus the component.
 *
 * @module features/settings/ui/runtimes/section-registry
 */
import type { ReactNode } from 'react';
import { ClaudeAccountsSection } from './sections/ClaudeAccountsSection';
import { PowerSourceSection } from './sections/PowerSourceSection';

/**
 * What a section renderer is told about the card it is rendering inside.
 *
 * Deliberately thin: renderers read config and requirements through their own
 * hooks (they are feature-layer components, so they may), and the runtime type
 * is the one thing they cannot derive. Widening this is how the registry rots —
 * every field added here is a field every future renderer must be handed.
 */
export interface RuntimeSettingsSectionContext {
  /** The runtime whose card is rendering this section, e.g. `'opencode'`. */
  type: string;
}

/** One declared section kind, drawn. */
type SectionRenderer = (ctx: RuntimeSettingsSectionContext) => ReactNode;

/** Every section kind this cockpit knows how to draw. */
const SECTION_RENDERERS: Record<string, SectionRenderer> = {
  'claude-accounts': () => <ClaudeAccountsSection />,
  'opencode-power-source': ({ type }) => <PowerSourceSection type={type} />,
};

/**
 * Render the bespoke settings section a runtime declared, by kind.
 *
 * An UNKNOWN kind renders nothing, deliberately and silently: an older cockpit
 * against a newer server will be handed section kinds it has never heard of, and
 * degrading to a card without that panel is the correct outcome — not a crash,
 * and not a console error the operator cannot act on. That forward-compatibility
 * rule is part of the runtime-authoring contract
 * (`contributing/adding-a-runtime.md`): declaring a section only makes it appear
 * in cockpits that ship a renderer for it.
 *
 * @param kind - The declared `RuntimeSettingsSection.kind`.
 * @param ctx - What the renderer needs about the card it sits in.
 * @returns The rendered section, or `null` for a kind with no renderer.
 */
export function renderRuntimeSettingsSection(
  kind: string,
  ctx: RuntimeSettingsSectionContext
): ReactNode {
  return SECTION_RENDERERS[kind]?.(ctx) ?? null;
}
