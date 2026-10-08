import type {
  BeatResult,
  BeatRaise,
  FacadeExtensions,
  JsonValue,
  ToolDescriptor,
  ToolRegistry,
} from '../contracts.js';
import { cancellable } from '../cancellation.js';
import { businessPrompt } from '../prompt.js';
const MAX_RAISES = 8,
  MAX_MESSAGE_CHARACTERS = 2000,
  MAX_INPUT_CHARACTERS = 32768;
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error('Unexpected beat outcome field');
}
/** Validate the bounded end_beat payload; it describes reporting intent and never sends a notification. */
export function validateBeatOutcome(
  value: unknown
): Extract<BeatResult, { kind: 'quiet' | 'raises' }> {
  if (!object(value)) throw new Error('Invalid beat outcome');
  if (value.kind === 'quiet') {
    exact(value, ['kind']);
    return { kind: 'quiet' };
  }
  if (
    value.kind !== 'raises' ||
    !Array.isArray(value.raises) ||
    value.raises.length < 1 ||
    value.raises.length > MAX_RAISES
  )
    throw new Error('Beat raises must contain 1 to 8 items');
  exact(value, ['kind', 'raises']);
  const seen = new Set<string>();
  const raises: BeatRaise[] = value.raises.map((item) => {
    if (!object(item)) throw new Error('Invalid beat raise');
    exact(item, ['message', 'rung']);
    if (
      typeof item.message !== 'string' ||
      !item.message.trim() ||
      item.message.length > MAX_MESSAGE_CHARACTERS ||
      typeof item.rung !== 'string' ||
      !['record', 'report', 'room', 'dm', 'notification'].includes(item.rung)
    )
      throw new Error('Invalid beat raise message or rung');
    const message = item.message.trim();
    if (seen.has(message)) throw new Error('Raise an issue only once per beat');
    seen.add(message);
    return { message, rung: item.rung as BeatRaise['rung'] };
  });
  return { kind: 'raises', raises };
}
/** Bounds include the scoped end_beat tool and every host schema selected for a request. */
export interface BeatOptions {
  maxTools?: number;
  maxSchemaBytes?: number;
}
/** Run one isolated beat under Doe's session guard; hosts own cadence, prior raises and notification delivery. */
export function createBeatExtension(
  options: BeatOptions = {}
): NonNullable<FacadeExtensions['runBeat']> {
  const maxTools = options.maxTools ?? 64;
  const maxSchemaBytes = options.maxSchemaBytes ?? 262144;
  if (
    !Number.isSafeInteger(maxTools) ||
    maxTools < 1 ||
    !Number.isSafeInteger(maxSchemaBytes) ||
    maxSchemaBytes < 1
  )
    throw new Error('Invalid beat tool budget');
  return async (request, context) => {
    context.signal.throwIfAborted();
    if (
      typeof request.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(request.id) ||
      context.scope !== `beat:${request.id}`
    )
      throw new Error('Invalid beat id or scope');
    for (const [key, value] of Object.entries({
      prompt: request.prompt,
      changes: request.changes,
      instructions: request.instructions,
      commitments: request.commitments,
    })) {
      if (value !== undefined && (typeof value !== 'string' || value.length > MAX_INPUT_CHARACTERS))
        throw new Error(`Invalid beat ${key}`);
    }
    if (typeof request.prompt !== 'string' || !request.prompt.trim())
      throw new Error('Beat prompt is required');
    const { store, sessionId } = context.config;
    const scope = context.scope;
    if (
      store.archive(sessionId, scope).length ||
      store.outcomes(sessionId, scope).length ||
      store.usage(sessionId, scope).length
    )
      throw new Error('Beat id already used; supply a new id');
    let decisionReason: string | undefined;
    if (request.decide) {
      const decision = await cancellable(Promise.resolve(request.decide()), context.signal);
      context.signal.throwIfAborted();
      if (
        !object(decision) ||
        !['run', 'skip'].includes(decision.action as string) ||
        typeof decision.reason !== 'string' ||
        !decision.reason.trim() ||
        decision.reason.length > 2000
      )
        throw new Error('Invalid beat decision');
      decisionReason = decision.reason;
      if (decision.action === 'skip') {
        const result: BeatResult = { kind: 'skipped', reason: decision.reason };
        return result;
      }
    }
    let batchFailed = false;
    let outcome: Extract<BeatResult, { kind: 'quiet' | 'raises' }> | undefined;
    const end: ToolDescriptor = {
      name: 'end_beat',
      description: 'Finish this beat quietly or record bounded reporting intent.',
      // Pi's non-strict Anthropic conversion preserves only root properties and required.
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['quiet', 'raises'] },
          raises: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_RAISES,
            items: {
              type: 'object',
              properties: {
                message: { type: 'string', minLength: 1, maxLength: MAX_MESSAGE_CHARACTERS },
                rung: { enum: ['record', 'report', 'room', 'dm', 'notification'] },
              },
              required: ['message', 'rung'],
              additionalProperties: false,
            },
          },
        },
        required: ['kind'],
        additionalProperties: false,
        oneOf: [
          {
            type: 'object',
            properties: { kind: { const: 'quiet' } },
            required: ['kind'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              kind: { const: 'raises' },
              raises: {
                type: 'array',
                minItems: 1,
                maxItems: MAX_RAISES,
                items: {
                  type: 'object',
                  properties: {
                    message: { type: 'string', minLength: 1, maxLength: MAX_MESSAGE_CHARACTERS },
                    rung: { enum: ['record', 'report', 'room', 'dm', 'notification'] },
                  },
                  required: ['message', 'rung'],
                  additionalProperties: false,
                },
              },
            },
            required: ['kind', 'raises'],
            additionalProperties: false,
          },
        ],
      },
      execute: async (args, toolContext) => {
        toolContext.signal.throwIfAborted();
        if (outcome) throw new Error('Beat already ended');
        outcome = validateBeatOutcome(args);
        return {
          content: [
            { type: 'text', text: 'Beat completion recorded for the end of this tool batch.' },
          ],
          structuredContent: outcome as unknown as JsonValue,
        };
      },
    };
    const host = context.config.registry;
    const registry: ToolRegistry = {
      register(tool) {
        if (tool.name === end.name) throw new Error('end_beat is reserved for beat execution');
        host.register(tool);
      },
      selected() {
        const selected = host.selected();
        if (selected.some((tool) => tool.name === end.name))
          throw new Error('end_beat is reserved for beat execution');
        const tools = [...selected, end];
        const bytes = Buffer.byteLength(
          JSON.stringify(
            tools.map(({ name, description, schema }) => ({ name, description, schema }))
          ),
          'utf8'
        );
        if (tools.length > maxTools || bytes > maxSchemaBytes)
          throw new Error('Beat selected tool budget exceeded');
        return tools;
      },
      search: (query, limit) => host.search(query, limit),
      execute: (name, args, toolContext) =>
        name === end.name ? end.execute(args, toolContext) : host.execute(name, args, toolContext),
    };
    const tools = registry.selected();
    const input = {
      prompt: request.prompt,
      ...(request.changes === undefined ? {} : { changes: request.changes }),
      ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
      ...(request.commitments === undefined ? {} : { commitments: request.commitments }),
      ...(decisionReason === undefined ? {} : { decisionReason }),
    };
    const result = await context.execute({
      prompt:
        businessPrompt(context.config.profile, '') +
        '\nThis is one autonomous beat. Use the supplied changes and commitments. Do useful work within your role; stay quiet when nothing changed. Raise an unchanged issue only once, using supplied commitments to recognize prior raises. Choose the lowest useful reporting rung. Free text is activity, never a user notification. Only explicit host posting tools send messages. Call end_beat to finish after the current tool batch.',
      messages: [{ role: 'user', content: JSON.stringify(input), timestamp: Date.now() }],
      tools,
      registry,
      scope,
      purpose: 'beat',
      finishTurn: async (messages, signal) => {
        if (signal.aborted) return 'end';
        let assistantIndex = messages.length - 1;
        while (assistantIndex >= 0 && messages[assistantIndex]?.role !== 'assistant')
          assistantIndex--;
        const batch = messages.slice(assistantIndex + 1);
        if (outcome) {
          batchFailed = batch.some(
            (message) => message.role === 'toolResult' && message.isError === true
          );
          return 'end';
        }
        const assistant = messages[assistantIndex];
        return assistant?.role === 'assistant' && assistant.stopReason === 'toolUse'
          ? 'continue'
          : 'end';
      },
    });
    context.signal.throwIfAborted();
    if (result.stopReason === 'aborted') throw new DOMException('Beat aborted', 'AbortError');
    if (result.stopReason !== 'stop') throw new Error(`Beat model ${result.stopReason}`);
    if (result.approvalDenied) throw new Error('Beat tool approval was refused');
    if (batchFailed) throw new Error('Beat tool batch failed');
    if (!outcome) throw new Error('Beat ended without end_beat');
    return outcome;
  };
}
