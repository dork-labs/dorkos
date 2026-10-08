import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type {
  BuilderConfig,
  ExecutionPolicy,
  ExecutionResult,
  JsonValue,
  PathPolicy,
  ToolDescriptor,
} from './contracts.js';
import { cancellable } from './cancellation.js';
import { canonicalPath } from './resources/paths.js';
import { DeferredToolRegistry, createToolSearch } from './registry/registry.js';
import { createLocalTools, createSkillTool, textResult } from './tools/local.js';
/** Child-owned resources and explicit shell authorization. File grants are not an OS sandbox.
 * Native unrestricted shell uses POSIX process groups; Windows requires an isolated executor.
 * Isolated executors must honor cancellation and terminate their own work.
 */
export interface BuilderToolOptions extends BuilderConfig {
  pathPolicy: PathPolicy;
  executionPolicy?: ExecutionPolicy;
  maxConcurrentProcesses?: number;
}
function limit(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error('Invalid builder limit');
  return value;
}
function argument(value: JsonValue, key: string): string {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value[key] !== 'string' ||
    !value[key].trim()
  )
    throw new Error(`${key} must be a nonempty string`);
  const text = value[key];
  if (text.length > 32768 || text.includes('\0')) throw new Error(`${key} exceeds input bounds`);
  return text;
}
/** Dedicated coding prompt with host guidance fenced as data. */
export function builderPrompt(guidance?: string): string {
  return `You are the coding builder. Implement and verify the task in the approved directory.
Use read, write, exact edit and search. Read applicable instructions before changing files.
Use shell only within the explicit host execution policy. File grants are not an OS shell sandbox.
Load relevant skills and resolve relative scripts beside their skill file.
Do not spawn another builder. Return a concise final result with changes, verification and unfinished work.
Never claim an aborted or failed action succeeded.
<host_guidance>${JSON.stringify(guidance ?? '').replace(/</g, '\\u003c')}</host_guidance>`;
}
/** Builder-only shell with bounded duration/output/process count and no inherited environment. */
export function createBuilderShell(options: BuilderToolOptions): ToolDescriptor {
  const duration = limit(options.maxDurationMs, 3600000),
    output = limit(options.maxOutputBytes, 16777216),
    concurrency = limit(options.maxConcurrentProcesses ?? 1, 16);
  const policy = options.executionPolicy;
  let active = 0;
  return {
    name: 'shell',
    description: 'Run a bounded command under explicit host execution policy.',
    initialLoad: true,
    schema: {
      type: 'object',
      properties: { command: { type: 'string', minLength: 1, maxLength: 32768 } },
      required: ['command'],
      additionalProperties: false,
    },
    execute: async (value, context) => {
      if (active >= concurrency)
        return { ...textResult('Builder process limit reached', output), isError: true };
      active++;
      try {
        context.signal.throwIfAborted();
        const command = argument(value, 'command');
        if (!policy) throw new Error('Shell requires an explicit host execution policy');
        if (policy.kind !== 'isolated' && policy.kind !== 'unrestricted')
          throw new Error('Invalid shell execution policy');
        if (
          policy.kind === 'unrestricted' &&
          (!policy.environment ||
            typeof policy.environment !== 'object' ||
            Array.isArray(policy.environment))
        )
          throw new Error('Explicit shell environment is required');
        if (policy.kind === 'unrestricted' && process.platform === 'win32')
          throw new Error('Windows shell requires an isolated executor');
        const cwd = await canonicalPath(options.workingDirectory, options.workingDirectory);
        if (!(await stat(cwd)).isDirectory())
          throw new Error('Builder directory must be a directory');
        context.signal.throwIfAborted();
        const controller = new AbortController(),
          signal = AbortSignal.any([context.signal, controller.signal]);
        const timer = setTimeout(
          () => controller.abort(new Error('Shell duration limit reached')),
          duration
        );
        try {
          let result: ExecutionResult;
          if (policy.kind === 'isolated')
            result = await cancellable(
              policy.execute({
                command,
                cwd,
                environment: {},
                timeoutMs: duration,
                maxOutputBytes: output,
                signal,
              }),
              signal
            );
          else
            result = await new Promise<ExecutionResult>((resolve, reject) => {
              signal.throwIfAborted();
              const environment = { ...policy.environment };
              for (const [key, val] of Object.entries(environment))
                if (
                  !key ||
                  key.includes('=') ||
                  key.includes('\0') ||
                  typeof val !== 'string' ||
                  val.includes('\0')
                )
                  throw new Error('Invalid shell environment');
              const child = spawn(command, {
                cwd,
                env: environment,
                shell: '/bin/sh',
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
              });
              let stdout = '',
                stderr = '',
                bytes = 0,
                truncated = false,
                failure: unknown;
              const stop = () => {
                if (!child.pid) return;
                try {
                  process.kill(-child.pid, 'SIGKILL');
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error;
                }
              };
              const aborted = () => {
                failure ??= signal.reason ?? new Error('Shell aborted');
                stop();
              };
              const chunk = (data: Buffer, stream: 'stdout' | 'stderr') => {
                const taken = data.subarray(0, Math.max(0, output - bytes));
                bytes += data.length;
                if (stream === 'stdout') stdout += taken.toString('utf8');
                else stderr += taken.toString('utf8');
                if (bytes > output) {
                  truncated = true;
                  failure ??= new Error('Shell output limit reached');
                  stop();
                }
              };
              child.stdout.on('data', (data) => chunk(data, 'stdout'));
              child.stderr.on('data', (data) => chunk(data, 'stderr'));
              child.once('error', (error) => {
                failure ??= error;
              });
              signal.addEventListener('abort', aborted, { once: true });
              if (signal.aborted) aborted();
              child.once('close', (exitCode) => {
                signal.removeEventListener('abort', aborted);
                // Redirected background descendants can outlive a successful shell leader.
                // Stop our held process group before releasing this command's slot/deadline.
                stop();
                if (failure) reject(failure);
                else resolve({ stdout, stderr, exitCode, truncated });
              });
            });
          signal.throwIfAborted();
          if (
            typeof result.stdout !== 'string' ||
            typeof result.stderr !== 'string' ||
            (result.exitCode !== null && !Number.isInteger(result.exitCode)) ||
            typeof result.truncated !== 'boolean'
          )
            throw new Error('Invalid isolated execution result');
          const bounded = textResult(result.stdout + result.stderr, output, {
            exitCode: result.exitCode,
          });
          if (
            bounded.structuredContent &&
            typeof bounded.structuredContent === 'object' &&
            !Array.isArray(bounded.structuredContent)
          )
            bounded.structuredContent.truncated =
              result.truncated || Buffer.byteLength(result.stdout + result.stderr) > output;
          return { ...bounded, ...(result.exitCode !== 0 ? { isError: true } : {}) };
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : 'Builder tool failed';
        return { ...textResult(text, output), isError: true };
      } finally {
        active--;
      }
    },
  };
}
/** Same-process scoped child; only bounded final text enters the business parent exchange. */
export function createBuilderTool(options: BuilderToolOptions): ToolDescriptor {
  const maxResult = limit(options.maxResultCharacters, 65536);
  limit(options.maxDurationMs, 3600000);
  limit(options.maxOutputBytes, 16777216);
  if (!options.workingDirectory.startsWith('/') && process.platform !== 'win32')
    throw new Error('Builder requires an absolute working directory');
  const extensions = [...(options.tools ?? [])];
  for (const tool of extensions)
    if (tool.name === 'builder' || tool.name === 'tool_search')
      throw new Error('Recursive builder or inherited tool search is forbidden');
  const shell = createBuilderShell(options);
  return {
    name: 'builder',
    description: 'Build coding tasks in a separate child conversation.',
    initialLoad: true,
    schema: {
      type: 'object',
      properties: { task: { type: 'string', minLength: 1, maxLength: 32768 } },
      required: ['task'],
      additionalProperties: false,
    },
    execute: async (value, context) => {
      try {
        context.signal.throwIfAborted();
        const task = argument(value, 'task');
        if (context.scope.startsWith('child:'))
          throw new Error('Recursive builder execution is forbidden');
        if (!context.execute) throw new Error('Builder requires bound scoped execution');
        const workingDirectory = await canonicalPath(
          options.workingDirectory,
          options.workingDirectory
        );
        if (!(await stat(workingDirectory)).isDirectory())
          throw new Error('Builder directory must be a directory');
        const registry = new DeferredToolRegistry();
        for (const tool of createLocalTools({ ...options, workingDirectory, builder: true }))
          registry.register({ ...tool, initialLoad: true });
        registry.register(createSkillTool(options.resources));
        registry.register(shell);
        for (const tool of extensions) registry.register(tool);
        registry.register(createToolSearch(registry));
        const childController = new AbortController();
        const childSignal = AbortSignal.any([context.signal, childController.signal]);
        const childTimer = setTimeout(
          () => childController.abort(new Error('Builder duration limit reached')),
          options.maxDurationMs
        );
        let result;
        try {
          result = await cancellable(
            context.execute({
              prompt: builderPrompt(options.guidance),
              messages: [{ role: 'user', content: task, timestamp: Date.now() }],
              tools: registry.selected(),
              registry,
              scope: `child:${randomUUID()}`,
              purpose: 'builder',
              signal: childSignal,
              workingDirectory,
              resources: options.resources,
              ...(options.model ? { model: options.model } : {}),
            }),
            childSignal
          );
        } finally {
          clearTimeout(childTimer);
        }
        context.signal.throwIfAborted();
        if (result.stopReason !== 'stop')
          throw new Error(`Builder ${result.stopReason}; no successful result`);
        if (result.approvalDenied) throw new Error('Builder tool approval was refused');
        const last = [...result.messages].reverse().find((m) => m.role === 'assistant');
        const text =
          typeof last?.content === 'string'
            ? last.content
            : Array.isArray(last?.content)
              ? last.content
                  .filter(
                    (part) =>
                      part &&
                      typeof part === 'object' &&
                      !Array.isArray(part) &&
                      part.type === 'text' &&
                      typeof part.text === 'string'
                  )
                  .map((part) => (part as { text: string }).text)
                  .join('\n')
              : '';
        if (!text.trim()) throw new Error('Builder returned no final result');
        const points = Array.from(text);
        return {
          content: [{ type: 'text', text: points.slice(0, maxResult).join('') }],
          structuredContent: { truncated: points.length > maxResult },
        };
      } catch (error) {
        const text = error instanceof Error ? error.message : 'Builder failed';
        return {
          content: [{ type: 'text', text: Array.from(text).slice(0, maxResult).join('') }],
          isError: true,
        };
      }
    },
  };
}
