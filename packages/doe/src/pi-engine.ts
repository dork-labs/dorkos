import { reportedUsage } from './provider-usage.js';
import { contextWithSnapshot } from './context-estimation.js';
import { storedBusinessPrompt } from './prompt.js';
import { confinedFetch } from './http-policy.js';
import { CredentialRedactor } from './credential-redactor.js';
import { cancellable, pause } from './cancellation.js';
import { randomUUID } from 'node:crypto';
import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentMessage, AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Model, ProviderStreams } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { lazyStream } from '@earendil-works/pi-ai/api/lazy';
import {
  getCurrentTools,
  getToolStateChanges,
  toToolDeclaration,
} from '@earendil-works/pi-ai/utils/transcript';
import { isRetryableAssistantError, retryDelayMs } from '@earendil-works/pi-ai/utils/retry';
import type { Engine, EngineRequest, EngineResult } from './engine.js';
import type {
  JsonValue,
  ModelDescriptor,
  ModelMessage,
  ModelUsage,
  QueueDisposition,
  ToolDescriptor,
} from './contracts.js';
type PiToolContent = Awaited<ReturnType<AgentTool['execute']>>['content'];
function jsonMessage(message: unknown): ModelMessage {
  // Pi's optional undefined bookkeeping is not JSON. Its own tool declarations already strip executable fields and TypeBox branding.
  return JSON.parse(JSON.stringify(message)) as ModelMessage;
}
function modelOf(descriptor: ModelDescriptor): Model<Api> {
  const url = new URL(descriptor.endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Invalid model endpoint');
  if (
    !descriptor.id ||
    !descriptor.payer ||
    !descriptor.historyFamily ||
    !Number.isSafeInteger(descriptor.contextWindow) ||
    descriptor.contextWindow < 1 ||
    !Number.isSafeInteger(descriptor.maxOutputTokens) ||
    descriptor.maxOutputTokens < 1
  )
    throw new Error('Invalid model descriptor');
  return {
    id: descriptor.id,
    name: descriptor.id,
    api: descriptor.protocol,
    provider: 'doe',
    baseUrl: descriptor.endpoint,
    input: descriptor.supportsImages ? ['text', 'image'] : ['text'],
    reasoning: descriptor.supportsThinking ?? false,
    contextWindow: descriptor.contextWindow,
    maxTokens: descriptor.maxOutputTokens,
    cost: descriptor.costRates ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}
async function provider(protocol: ModelDescriptor['protocol']): Promise<ProviderStreams> {
  switch (protocol) {
    case 'anthropic-messages':
      return (
        await import('@earendil-works/pi-ai/api/anthropic-messages.lazy')
      ).anthropicMessagesApi();
    case 'openai-completions':
      return (
        await import('@earendil-works/pi-ai/api/openai-completions.lazy')
      ).openAICompletionsApi();
    case 'openai-responses':
      return (await import('@earendil-works/pi-ai/api/openai-responses.lazy')).openAIResponsesApi();
    default:
      throw new Error('Unsupported model protocol');
  }
}
/** Single Pi boundary: explicit lazy provider calls, existing queues, tool approvals and lossless complete events. */
export class PiEngine implements Engine {
  private agent?: Agent;
  /** Execute a complete context with Pi's loop, awaiting persistence before terminal settlement. */
  async run(request: EngineRequest): Promise<EngineResult> {
    if (this.agent) throw new Error('Engine already active');
    if (
      request.retry &&
      (!Number.isSafeInteger(request.retry.maxAttempts) ||
        request.retry.maxAttempts < 1 ||
        request.retry.maxAttempts > 20)
    )
      throw new Error('Retry attempts must be between 1 and 20');
    const base = modelOf(request.model);
    let activeDescriptor = request.model;
    let persistenceError: unknown;
    let toolEffect = false;
    let approvalDenied = false;
    const redactor = new CredentialRedactor();
    const redact = (text: string) => redactor.text(text);
    const emit: EngineRequest['onEvent'] = (event) => request.onEvent(redactor.json(event));
    let last: AssistantMessage | undefined;
    const completed: ModelMessage[] = [];
    const persist = async (message: ModelMessage): Promise<void> => {
      try {
        await request.onMessage(redactor.json(message));
      } catch (error) {
        persistenceError ??= error;
        throw error;
      }
    };
    const streamFn: StreamFn = (model, context, options) =>
      lazyStream(model, async () => {
        const outer = new AssistantMessageEventStream();
        void (async () => {
          let attempt = 0;
          let substituted = 0;
          for (;;) {
            const signal = options?.signal ?? request.signal;
            signal.throwIfAborted();
            const key = await cancellable(
              Promise.resolve(activeDescriptor.credentials(signal)),
              signal
            );
            if (key) redactor.add(key);
            if (key?.includes('sk-ant-oat'))
              throw new Error('Anthropic subscription tokens are refused');
            if (!key && activeDescriptor.requiresCredentials !== false)
              throw new Error('Missing explicit model credentials');
            const explicitKey = key || 'doe-explicit-unauthenticated';
            const implementation = await provider(activeDescriptor.protocol);
            const current = modelOf(activeDescriptor);
            let emitted = false;
            let responseStatus: number | undefined;
            const usage: ModelUsage = { requestId: randomUUID(), modelId: activeDescriptor.id };
            const source = implementation.streamSimple(current, context, {
              ...options,
              apiKey: explicitKey,
              maxTokens: activeDescriptor.maxOutputTokens,
              maxRetries: 0,
              fetch: confinedFetch(activeDescriptor.endpoint, (status) => {
                responseStatus = status;
              }),
              cacheRetention: 'none',
              env: { PI_CACHE_RETENTION: 'short' },
              onResponse: (response) => {
                responseStatus = response.status;
              },
              onProviderStreamEvent: async (event) => {
                reportedUsage(event, usage);
              },
            });
            for await (const event of source) {
              if (event.type === 'text_delta' || event.type === 'thinking_delta') emitted = true;
              if (event.type === 'text_delta' || event.type === 'thinking_delta') {
                const delta = redactor.delta(`${event.type}:${event.contentIndex}`, event.delta);
                if (delta) outer.push(redactor.json({ ...event, delta }));
              } else if (event.type === 'text_end' || event.type === 'thinking_end') {
                const type = event.type === 'text_end' ? 'text_delta' : 'thinking_delta';
                const delta = redactor.delta(`${type}:${event.contentIndex}`, '', true);
                if (delta) outer.push(redactor.json({ ...event, type, delta }) as never);
                outer.push(redactor.json(event));
              } else if (event.type !== 'done' && event.type !== 'error')
                outer.push(redactor.json(event));
            }
            let result = await source.result();
            result = redactor.json(result);
            if (
              activeDescriptor.costRates &&
              usage.inputTokens !== undefined &&
              usage.outputTokens !== undefined
            )
              usage.costUsd = result.usage.cost.total;
            try {
              await request.onUsage(redactor.json(usage));
            } catch (error) {
              persistenceError ??= error;
              throw error;
            }
            const retryable =
              result.stopReason === 'error' &&
              !signal.aborted &&
              !emitted &&
              !toolEffect &&
              ![401, 403, 429].includes(responseStatus ?? 0) &&
              isRetryableAssistantError(result);
            const max = request.retry?.maxAttempts ?? 1;
            if (retryable && (attempt + 1 < max || request.retry?.fallbacks?.[substituted])) {
              await persist(jsonMessage(result));
              completed.push(jsonMessage(result));
            }
            if (retryable && attempt + 1 < max) {
              attempt++;
              emit({ type: 'retry', attempt, scope: request.context.scope });
              const delay =
                request.retry?.delayMs(attempt) ??
                retryDelayMs({ baseDelayMs: 100, maxAgentDelayMs: 1000 }, attempt);
              if (!Number.isFinite(delay) || delay < 0 || delay > 300000)
                throw new Error('Invalid retry delay');
              await pause(delay, signal);
              continue;
            }
            const fallback = request.retry?.fallbacks?.[substituted];
            if (retryable && fallback) {
              if (
                fallback.payer !== request.model.payer ||
                fallback.historyFamily !== request.model.historyFamily ||
                fallback.protocol !== request.model.protocol
              )
                throw new Error('Fallback must preserve payer and protocol/history compatibility');
              substituted++;
              emit({
                type: 'substitution',
                from: activeDescriptor.id,
                to: fallback.id,
                scope: request.context.scope,
              });
              activeDescriptor = fallback;
              attempt = 0;
              continue;
            }
            outer.push(
              result.stopReason === 'error' || result.stopReason === 'aborted'
                ? { type: 'error', reason: result.stopReason, error: result }
                : {
                    type: 'done',
                    reason: result.stopReason as 'stop' | 'length' | 'toolUse',
                    message: result,
                  }
            );
            outer.end(result);
            break;
          }
        })().catch((error) => {
          const message: AssistantMessage = {
            role: 'assistant',
            content: [],
            api: activeDescriptor.protocol,
            provider: 'doe',
            model: activeDescriptor.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: request.signal.aborted ? 'aborted' : 'error',
            errorMessage: error instanceof Error ? redact(error.message) : 'Model request failed',
            timestamp: Date.now(),
          };
          outer.push({
            type: 'error',
            reason: message.stopReason as 'error' | 'aborted',
            error: message,
          });
          outer.end(message);
        });
        return outer;
      });
    const tools = (descriptors: readonly ToolDescriptor[]): AgentTool[] =>
      descriptors.map((descriptor) => ({
        name: descriptor.name,
        label: descriptor.name,
        description: descriptor.description,
        parameters: descriptor.schema as AgentTool['parameters'],
        execute: async (callId, args, signal) => {
          toolEffect = true;
          const combined = signal ? AbortSignal.any([signal, request.signal]) : request.signal;
          const result = await cancellable(
            descriptor.execute(args as JsonValue, {
              ...request.context,
              callId,
              signal: combined,
              emit,
            }),
            combined
          );
          return {
            content: result.content as unknown as PiToolContent,
            details: result.structuredContent ?? null,
            ...(result.structuredContent === undefined
              ? {}
              : { structuredContent: result.structuredContent }),
            isError: result.isError ?? false,
          };
        },
      }));
    let executable = tools(request.tools);
    let currentPrompt = request.prompt;
    const initial: ModelMessage = {
      role: 'system',
      content: '',
      sections: { doe: currentPrompt },
      toolsAdded: executable.map(toToolDeclaration) as unknown as JsonValue,
      timestamp: Date.now(),
    };
    const messages = contextWithSnapshot(request.messages);
    const existingSystem = messages.some((m) => m.role === 'system');
    if (!existingSystem) {
      messages.unshift(initial);
      await persist(initial);
      completed.push(initial);
    }
    const agent = new Agent({
      initialState: {
        messages: messages as unknown as AgentMessage[],
        model: base,
        tools: executable,
      },
      streamFn,
      toolExecution: 'sequential',
      steeringMode: 'all',
      followUpMode: 'all',
      beforeToolCall: async (ctx, signal) => {
        const combined = signal ? AbortSignal.any([signal, request.signal]) : request.signal;
        combined.throwIfAborted();
        const descriptor =
          request.tools.find((t) => t.name === ctx.toolCall.name) ??
          this.currentTools.find((t) => t.name === ctx.toolCall.name);
        if (!descriptor) return { block: true, reason: 'Unknown selected tool' };
        if (
          request.approve &&
          (await cancellable(
            request.approve(descriptor, ctx.args as JsonValue, {
              ...request.context,
              emit,
              callId: ctx.toolCall.id,
              signal: combined,
            }),
            combined
          )) !== 'allow'
        ) {
          approvalDenied = true;
          return { block: true, reason: 'Host refused tool approval' };
        }
        return undefined;
      },
      prepareRequest: async (ctx, signal) => {
        if (persistenceError) throw persistenceError;
        const combined = signal ? AbortSignal.any([signal, request.signal]) : request.signal;
        const update = await request.prepareRequest?.(
          ctx.context.messages.map(jsonMessage),
          combined
        );
        if (update?.tools) {
          this.currentTools = update.tools;
          executable = tools(update.tools);
        }
        const next = contextWithSnapshot(
          update?.messages ?? ctx.context.messages.map(jsonMessage)
        ) as unknown as AgentMessage[];
        const changes = getToolStateChanges(
          getCurrentTools(next),
          executable.map(toToolDeclaration)
        );
        const nextPrompt = update?.prompt ?? currentPrompt;
        if (
          nextPrompt !== storedBusinessPrompt(next.map(jsonMessage)) ||
          changes.toolsAdded.length ||
          changes.toolsRemoved.length ||
          !next.some((m) => m.role === 'system')
        ) {
          const system = {
            role: 'system',
            content: '',
            sections: { doe: nextPrompt },
            ...(changes.toolsAdded.length ? { toolsAdded: changes.toolsAdded } : {}),
            ...(changes.toolsRemoved.length ? { toolsRemoved: changes.toolsRemoved } : {}),
            timestamp: Date.now(),
          } as const;
          await persist(jsonMessage(system));
          completed.push(jsonMessage(system));
          next.push(system as AgentMessage);
        }
        currentPrompt = nextPrompt;
        return { context: { messages: next, tools: executable }, model: modelOf(activeDescriptor) };
      },
      ...(request.finishTurn
        ? {
            finishTurn: async (turn, signal) => ({
              action: await request.finishTurn!(
                turn.newMessages.map((message) => redactor.json(jsonMessage(message))),
                signal ?? request.signal
              ),
            }),
          }
        : {}),
    });
    this.currentTools = request.tools;
    this.agent = agent;
    const abort = () => agent.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    agent.subscribe(async (event) => {
      if (persistenceError) return;
      try {
        switch (event.type) {
          case 'message_end': {
            const message = redactor.json(jsonMessage(event.message));
            await persist(message);
            completed.push(message);
            if (event.message.role === 'assistant') last = event.message;
            break;
          }
          case 'message_update': {
            const e = event.assistantMessageEvent;
            if (e.type === 'text_delta' || e.type === 'thinking_delta')
              emit({
                type: e.type === 'text_delta' ? 'text' : 'thinking',
                delta: e.delta,
                scope: request.context.scope,
              });
            break;
          }
          case 'tool_execution_start':
            emit({
              type: 'tool-start',
              name: event.toolName,
              callId: event.toolCallId,
              scope: request.context.scope,
            });
            break;
          case 'tool_execution_end':
            emit({
              type: 'tool-end',
              name: event.toolName,
              callId: event.toolCallId,
              scope: request.context.scope,
              result: {
                content: event.result.content,
                isError: event.isError,
                ...(event.result.structuredContent === undefined
                  ? {}
                  : { structuredContent: event.result.structuredContent }),
              },
            });
            break;
        }
      } catch (error) {
        persistenceError = error;
        agent.abort();
        throw error;
      }
    });
    try {
      request.signal.throwIfAborted();
      await agent.continue();
      if (persistenceError) throw persistenceError;
      return {
        messages: completed,
        ...(approvalDenied ? { approvalDenied: true } : {}),
        scope: request.context.scope,
        stopReason:
          request.signal.aborted || last?.stopReason === 'aborted'
            ? 'aborted'
            : last?.stopReason === 'error'
              ? 'error'
              : last?.stopReason === 'length'
                ? 'length'
                : 'stop',
      };
    } finally {
      request.signal.removeEventListener('abort', abort);
      this.agent = undefined;
      this.currentTools = [];
    }
  }
  private currentTools: readonly ToolDescriptor[] = [];
  /** Delegate steering to Pi's existing queue. */
  steer(message: ModelMessage): QueueDisposition {
    if (!this.agent) return 'idle';
    this.agent.steer(message as unknown as AgentMessage);
    return 'queued';
  }
  /** Delegate follow-up to Pi's existing queue. */
  followUp(message: ModelMessage): QueueDisposition {
    if (!this.agent) return 'idle';
    this.agent.followUp(message as unknown as AgentMessage);
    return 'queued';
  }
  /** Abort Pi and its signal-bearing tools. */
  abort(): void {
    this.agent?.abort();
  }
}
