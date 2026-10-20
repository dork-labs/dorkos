/**
 * Which decision models the watch-only post checks may call, and the one switch that lets them
 * spend money.
 *
 * **A key alone arms nothing** (AGENTS.md, the money-paths table). Calling Jev or an
 * OpenAI-format model costs money, so each needs its key AND `COMMUNITY_DECISIONS_PAID=1`. The
 * flag is read once, at module scope, into {@link PAID_DECISIONS_ARMED}: no later
 * `process.env` write or test stub can switch it on, and {@link decisionSettings} ignores any
 * copy of it in the environment it is handed. Without it the checks run the free built-in rules
 * and nothing else.
 *
 * Every model is counted against a daily call cap. Past the cap the check records "unsure"
 * and calls nothing more that day.
 *
 * @module decisions/settings
 */
import { z } from 'zod';
import {
  DEFAULT_JEV_MODEL,
  OPENROUTER_API_BASE,
  createJevModel,
  createOpenAiCompatibleModel,
  type FetchLike,
} from '@dorkos/decisions';
import type { DecisionModel } from '@dorkos/shared/decision-model';

/** The variable that arms paid calls. Named here so docs and guards can point at one place. */
export const DECISIONS_PAID_FLAG = 'COMMUNITY_DECISIONS_PAID';

/** The keys. Each arms nothing without {@link DECISIONS_PAID_FLAG}. */
export const DECISIONS_KEY_VARS = {
  jev: 'COMMUNITY_DECISIONS_JEV_KEY',
  openai: 'COMMUNITY_DECISIONS_OPENAI_KEY',
} as const;

/** Read once, when this module loads. The only thing that can arm a paid call. */
// eslint-disable-next-line no-restricted-syntax -- the money switch is read here, once, at module scope
export const PAID_DECISIONS_ARMED = process.env[DECISIONS_PAID_FLAG] === '1';

/** Calls per model per UTC day when the host sets no cap. */
export const DEFAULT_DAILY_CALL_CAP = 1000;

/** One decision model in its slot, beside the built-in rules. */
export interface ModelSlot {
  /** `jev` or `openai`: the check's name in records and reports. */
  check: 'jev' | 'openai';
  model: DecisionModel;
}

/** What the checks run with. */
export interface DecisionSettings {
  /** The armed models, side by side on the same posts. Empty: rules only. */
  models: ModelSlot[];
  /** Calls per model per UTC day. 0 calls no model. */
  dailyCallCap: number;
  /** Keys that are set but armed nothing because the flag is off, for one line at boot. */
  unarmedKeys: string[];
}

const optional = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional();
const price = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, 'a number of US dollars per million tokens')
  .transform(Number)
  .optional();

const EnvSchema = z.object({
  COMMUNITY_DECISIONS_JEV_KEY: optional,
  COMMUNITY_DECISIONS_JEV_MODEL: optional,
  COMMUNITY_DECISIONS_JEV_BASE_URL: z.url().optional(),
  /** US dollars per million input tokens, for the cost figures. */
  COMMUNITY_DECISIONS_JEV_PRICE: price,
  COMMUNITY_DECISIONS_OPENAI_KEY: optional,
  COMMUNITY_DECISIONS_OPENAI_MODEL: optional,
  COMMUNITY_DECISIONS_OPENAI_BASE_URL: z.url().optional(),
  /** US dollars per million input tokens, for the cost figures. */
  COMMUNITY_DECISIONS_OPENAI_PRICE_IN: price,
  /** US dollars per million output tokens, for the cost figures. */
  COMMUNITY_DECISIONS_OPENAI_PRICE_OUT: price,
  COMMUNITY_DECISIONS_DAILY_CAP: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

/** Dollars per million tokens to millionths of a dollar per token: the same number. */
const microUsd = (perMillion: number | undefined, tokens: number) =>
  perMillion === undefined ? 0 : perMillion * tokens;

/**
 * Work out which models the checks may call.
 *
 * @param env - The environment to read keys and settings from. A `COMMUNITY_DECISIONS_PAID` in
 *   it is ignored: only `paidArmed` arms.
 * @param deps.paidArmed - Whether paid calls are armed; production passes
 *   {@link PAID_DECISIONS_ARMED}.
 * @param deps.fetch - The fetch the bridges call.
 * @throws When a setting is malformed, or an armed OpenAI-format key has no base URL or model.
 */
export function decisionSettings(
  env: Record<string, string | undefined>,
  deps: { paidArmed: boolean; fetch: FetchLike }
): DecisionSettings {
  const value = EnvSchema.parse(env);
  const dailyCallCap = value.COMMUNITY_DECISIONS_DAILY_CAP ?? DEFAULT_DAILY_CALL_CAP;
  const setKeys = (Object.keys(DECISIONS_KEY_VARS) as Array<keyof typeof DECISIONS_KEY_VARS>)
    .filter((slot) => value[DECISIONS_KEY_VARS[slot]] !== undefined)
    .map((slot) => DECISIONS_KEY_VARS[slot]);
  if (!deps.paidArmed) return { models: [], dailyCallCap, unarmedKeys: setKeys };

  const models: ModelSlot[] = [];
  if (value.COMMUNITY_DECISIONS_JEV_KEY) {
    const jevPrice = value.COMMUNITY_DECISIONS_JEV_PRICE;
    models.push({
      check: 'jev',
      model: createJevModel({
        apiKey: value.COMMUNITY_DECISIONS_JEV_KEY,
        model: value.COMMUNITY_DECISIONS_JEV_MODEL ?? DEFAULT_JEV_MODEL,
        baseUrl: value.COMMUNITY_DECISIONS_JEV_BASE_URL ?? OPENROUTER_API_BASE,
        fetch: deps.fetch,
        ...(jevPrice !== undefined
          ? { costMicroUsd: (inputTokens: number) => microUsd(jevPrice, inputTokens) }
          : {}),
      }),
    });
  }
  if (value.COMMUNITY_DECISIONS_OPENAI_KEY) {
    const model = value.COMMUNITY_DECISIONS_OPENAI_MODEL;
    const baseUrl = value.COMMUNITY_DECISIONS_OPENAI_BASE_URL;
    if (!model || !baseUrl)
      throw new Error(
        'COMMUNITY_DECISIONS_OPENAI_KEY needs COMMUNITY_DECISIONS_OPENAI_BASE_URL and COMMUNITY_DECISIONS_OPENAI_MODEL.'
      );
    const priceIn = value.COMMUNITY_DECISIONS_OPENAI_PRICE_IN;
    const priceOut = value.COMMUNITY_DECISIONS_OPENAI_PRICE_OUT;
    models.push({
      check: 'openai',
      model: createOpenAiCompatibleModel({
        apiKey: value.COMMUNITY_DECISIONS_OPENAI_KEY,
        model,
        baseUrl,
        fetch: deps.fetch,
        ...(priceIn !== undefined || priceOut !== undefined
          ? {
              costMicroUsd: (usage) =>
                microUsd(priceIn, usage.promptTokens) + microUsd(priceOut, usage.completionTokens),
            }
          : {}),
      }),
    });
  }
  return { models, dailyCallCap, unarmedKeys: [] };
}
