/**
 * The first-run API (spec `one-minute-onboarding` §4): the path a person picks
 * on the Welcome screen, and DorkBot's welcome in #team.
 *
 * @module shared/onboarding-schemas
 */
import { z } from 'zod';
import { DoeInferenceConfigSchema } from './config-schema.js';

/** The services the Own AI list sets up from a key alone. */
export const OWN_AI_KEY_SERVICES = ['openai', 'anthropic', 'openrouter'] as const;

/** One of {@link OWN_AI_KEY_SERVICES}. */
export type OwnAiKeyService = (typeof OWN_AI_KEY_SERVICES)[number];

/**
 * A model setup for the DorkOS runtime as a person types it in: no key
 * reference, because the key travels beside it and the server stores it.
 */
const OwnAiInferenceSchema = DoeInferenceConfigSchema.safeExtend({
  source: z.enum(['api-key', 'local']),
  credentialRef: z.never().optional(),
  credentialEndpoint: z.never().optional(),
});

/**
 * What a person picked in the Own AI list:
 *
 * - `openai`, `anthropic`, `openrouter`: a key; DorkOS picks the model.
 * - `local`: a model on this computer (Ollama on its default port).
 * - `custom`: another service, set up by hand (endpoint, format, model, key).
 * - `agent-app`: an AI app they sign in to (Claude Code, Codex, OpenCode). The
 *   app's own connect cards do the rest.
 */
export const OwnAiChoiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('openai'), apiKey: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('anthropic'), apiKey: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('openrouter'), apiKey: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('local') }).strict(),
  z
    .object({
      kind: z.literal('custom'),
      inference: OwnAiInferenceSchema,
      apiKey: z.string().min(1).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('agent-app') }).strict(),
]);

/** What a person picked in the Own AI list. */
export type OwnAiChoice = z.infer<typeof OwnAiChoiceSchema>;

/** `POST /api/onboarding/first-run` — the path picked on the Welcome screen. */
export const FirstRunRequestSchema = z.discriminatedUnion('path', [
  z.object({ path: z.literal('dorkos') }).strict(),
  z.object({ path: z.literal('own'), choice: OwnAiChoiceSchema }).strict(),
  z.object({ path: z.literal('none') }).strict(),
]);

/** The path picked on the Welcome screen. */
export type FirstRunRequest = z.infer<typeof FirstRunRequestSchema>;

/** `POST /api/onboarding/first-run` — what the pick set up. */
export const FirstRunResultSchema = z.object({
  /** The path now recorded. */
  path: z.enum(['dorkos', 'own', 'none']),
  /** The runtime new conversations start on now. */
  runtime: z.string(),
  /** The model DorkOS picked for the DorkOS runtime, when this pick set one. */
  model: z.string().optional(),
  /**
   * For a key: whether the model came from the service's own list. `false`
   * means the list could not be read, so the key was kept and DorkOS started
   * on the service's usual model; the app may say so quietly.
   */
  modelListed: z.boolean().optional(),
});

/** What a first-run pick set up. */
export type FirstRunResult = z.infer<typeof FirstRunResultSchema>;

/**
 * Why `POST /api/onboarding/first-run` refused, beside its sentence. Every
 * refusal leaves the previous pick exactly as it was:
 *
 * - `onboarding_complete`: the first run is finished or dismissed.
 * - `invalid_key`: the key was refused, by DorkOS (empty, or a subscription
 *   token) or by the service itself (it answered 401 or 403).
 * - `invalid_setup`: a hand-typed setup did not check out.
 * - `models_unreachable`: a model on this computer did not answer. A key is
 *   never refused for this: a list that cannot be read keeps the key.
 */
export type FirstRunRefusalCode =
  'onboarding_complete' | 'models_unreachable' | 'invalid_key' | 'invalid_setup';

/** `POST /api/onboarding/welcome` — DorkBot's welcome in #team. */
export const OnboardingWelcomeResultSchema = z.object({
  /** The #team room. */
  roomId: z.string(),
  /** The welcome's entry, posted once and reused after. */
  entryId: z.string(),
});

/** DorkBot's welcome in #team. */
export type OnboardingWelcomeResult = z.infer<typeof OnboardingWelcomeResultSchema>;
