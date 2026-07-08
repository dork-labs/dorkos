/**
 * Feature flags for the generative-UI widget layer.
 *
 * @module features/gen-ui/config/feature-flags
 */

/**
 * Whether `agent`-kind widget actions (and `form` submits, which are always
 * agent actions) are enabled. `false` in PR D: the interaction channel
 * (`POST /api/sessions/:id/ui-action`) ships in PR E. Until then these actions
 * render disabled with a tooltip. Flipping this to `true` is the one-line switch
 * that enables them once the channel exists.
 */
export const WIDGET_AGENT_ACTIONS_ENABLED = false;
