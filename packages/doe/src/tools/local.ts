import { open, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import type {
  JsonValue,
  PathPolicy,
  Resources,
  ToolContext,
  ToolDescriptor,
  ToolResult,
} from '../contracts.js';
import { CanonicalPaths } from '../resources/paths.js';
/** Explicit bounded local-tool configuration; editing and searching belong only to builder. */
export interface LocalToolOptions {
  resources: Resources;
  pathPolicy: PathPolicy;
  workingDirectory: string;
  builder?: boolean;
  maxOutputBytes?: number;
  maxFileBytes?: number;
  maxSearchFiles?: number;
  /** Separate complete-instruction budget; oversized instructions fail rather than truncate. */
  maxInstructionBytes?: number;
}
function positive(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error('Invalid tool limit');
  return result;
}
function object(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Arguments must be an object');
  return value;
}
function string(value: JsonValue | undefined, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}
/** Build an explicitly byte-bounded text result without splitting a UTF-8 character. */
export function textResult(
  text: string,
  maxBytes: number,
  extra: Record<string, JsonValue> = {}
): ToolResult {
  const buffer = Buffer.from(text);
  const truncated = buffer.length > maxBytes;
  let end = Math.min(buffer.length, maxBytes);
  if (truncated) while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return {
    content: [{ type: 'text', text: buffer.subarray(0, end).toString('utf8') }],
    structuredContent: { ...extra, truncated },
  };
}
/** Normalize local errors into tool errors; callers never receive false successful actions. */
export function toolError(error: unknown): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: error instanceof Error ? error.message : 'Tool failed' }],
  };
}
async function boundedFile(file: string, limit: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!(await stat(file)).isFile()) throw new Error('Path must be a regular file');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Path must be a regular file');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    signal.throwIfAborted();
    if (bytesRead > limit) throw new Error('File exceeds byte limit');
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, bytesRead)
      );
    } catch (cause) {
      throw new Error('File must contain valid UTF-8 text', { cause });
    }
  } finally {
    await handle.close();
  }
}
async function writeText(file: string, content: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  try {
    if (!(await stat(file)).isFile()) throw new Error('Path must be a regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Path must be a regular file');
    signal.throwIfAborted();
    await handle.truncate(0);
    await handle.writeFile(content, { signal });
  } finally {
    await handle.close();
  }
}
function schema(properties: Record<string, JsonValue>): Record<string, JsonValue> {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
const stringSchema = { type: 'string' };
/** Create business read/write descriptors, optionally adding builder-only exact edit/search. */
export function createLocalTools(options: LocalToolOptions): readonly ToolDescriptor[] {
  const maxOutput = positive(options.maxOutputBytes, 16 * 1024);
  const maxFile = positive(options.maxFileBytes, 1024 * 1024);
  const maxFiles = positive(options.maxSearchFiles, 1000);
  const maxInstructions = positive(options.maxInstructionBytes, 256 * 1024);
  const paths = new CanonicalPaths(options.pathPolicy, options.workingDirectory);
  async function prepare(
    raw: string,
    mutate: boolean,
    context: ToolContext
  ): Promise<{ target: string; retry?: ToolResult; instructions: string }> {
    context.signal.throwIfAborted();
    const target = await paths.resolve(raw, mutate ? 'write' : 'read');
    const instructions = await options.resources.beforeFile(target, context.signal);
    if (Buffer.byteLength(instructions) > maxInstructions)
      throw new Error('Instructions exceed byte limit');
    if (mutate && instructions)
      return {
        target,
        instructions,
        retry: {
          isError: true,
          content: [
            {
              type: 'text',
              text: `New instructions loaded. Review them and retry this operation.\n\n${instructions}`,
            },
          ],
          structuredContent: { retryRequired: true, mutated: false },
        },
      };
    return { target, instructions };
  }
  function descriptor(
    name: string,
    description: string,
    properties: Record<string, JsonValue>,
    execute: (args: Record<string, JsonValue>, context: ToolContext) => Promise<ToolResult>
  ): ToolDescriptor {
    return {
      name,
      description,
      schema: schema(properties),
      initialLoad: name === 'read' || name === 'write',
      execute: async (value, context) => {
        try {
          const args = object(value);
          for (const key of Object.keys(properties)) string(args[key], key);
          if (Object.keys(args).some((key) => !(key in properties)))
            throw new Error('Unknown argument');
          return await execute(args, context);
        } catch (error) {
          return toolError(error);
        }
      },
    };
  }
  const read = descriptor(
    'read',
    'Read a bounded local text file.',
    { path: stringSchema },
    async (args, context) => {
      const { target, instructions } = await prepare(string(args.path, 'path'), false, context);
      const text = await boundedFile(await paths.resolve(target, 'read'), maxFile, context.signal);
      return textResult(text, maxOutput, instructions ? { instructions } : {});
    }
  );
  const write = descriptor(
    'write',
    'Write a bounded local text file.',
    { path: stringSchema, content: stringSchema },
    async (args, context) => {
      const content = string(args.content, 'content');
      if (Buffer.byteLength(content) > maxFile) throw new Error('Content exceeds byte limit');
      const prepared = await prepare(string(args.path, 'path'), true, context);
      if (prepared.retry) return prepared.retry;
      await mkdir(path.dirname(prepared.target), { recursive: true });
      const target = await paths.resolve(prepared.target, 'write');
      context.signal.throwIfAborted();
      await writeText(target, content, context.signal);
      return textResult('File written.', maxOutput);
    }
  );
  if (!options.builder) return [read, write];
  const edit = descriptor(
    'edit',
    'Replace one unique exact text match in a local file.',
    { path: stringSchema, oldText: stringSchema, newText: stringSchema },
    async (args, context) => {
      const oldText = string(args.oldText, 'oldText');
      const newText = string(args.newText, 'newText');
      if (!oldText) throw new Error('oldText must not be empty');
      const prepared = await prepare(string(args.path, 'path'), true, context);
      if (prepared.retry) return prepared.retry;
      const content = await boundedFile(
        await paths.resolve(prepared.target, 'read'),
        maxFile,
        context.signal
      );
      const index = content.indexOf(oldText);
      if (index < 0) throw new Error('Exact text not found');
      if (content.indexOf(oldText, index + 1) >= 0)
        throw new Error('Exact text is ambiguous; include more context');
      const replacement = content.slice(0, index) + newText + content.slice(index + oldText.length);
      if (Buffer.byteLength(replacement) > maxFile)
        throw new Error('Edited content exceeds byte limit');
      context.signal.throwIfAborted();
      const target = await paths.resolve(prepared.target, 'write');
      await writeText(target, replacement, context.signal);
      return textResult('File edited.', maxOutput);
    }
  );
  const search = descriptor(
    'search',
    'Find literal text in bounded local files.',
    { path: stringSchema, query: stringSchema },
    async (args, context) => {
      const query = string(args.query, 'query');
      if (!query || Buffer.byteLength(query) > 1024)
        throw new Error('Search query must contain 1 to 1024 bytes');
      const { target } = await prepare(string(args.path, 'path'), false, context);
      const lines: string[] = [];
      const visited = new Set<string>();
      let files = 0;
      let entries = 0;
      let outputBytes = 0;
      let stopped = false;
      const instructionTexts = new Set<string>();
      const walk = async (candidate: string): Promise<void> => {
        context.signal.throwIfAborted();
        if (stopped) return;
        const canonical = await paths.resolve(candidate, 'read');
        if (visited.has(canonical)) return;
        visited.add(canonical);
        const info = await stat(canonical);
        if (info.isDirectory()) {
          const children = (await readdir(canonical)).sort();
          for (const child of children) {
            if (++entries > maxFiles * 4) {
              stopped = true;
              break;
            }
            if (child.startsWith('.') || child === 'node_modules') continue;
            await walk(path.join(canonical, child));
            if (stopped) break;
          }
          return;
        }
        if (!info.isFile()) return;
        if (++files > maxFiles) {
          stopped = true;
          return;
        }
        const instructions = await options.resources.beforeFile(canonical, context.signal);
        if (instructions) {
          instructionTexts.add(instructions);
          if (Buffer.byteLength([...instructionTexts].join('\n\n')) > maxInstructions)
            throw new Error('Instructions exceed byte limit');
        }
        if (info.size > maxFile) return;
        let content: string;
        try {
          content = await boundedFile(
            await paths.resolve(canonical, 'read'),
            maxFile,
            context.signal
          );
        } catch (error) {
          if (error instanceof Error && error.message === 'File must contain valid UTF-8 text')
            return;
          throw error;
        }
        const contentLines = content.split('\n');
        for (let index = 0; index < contentLines.length; index++)
          if (contentLines[index].includes(query)) {
            const line = `${canonical}:${index + 1}:${contentLines[index]}`;
            lines.push(line);
            outputBytes += Buffer.byteLength(line) + 1;
            if (outputBytes > maxOutput) {
              stopped = true;
              break;
            }
          }
      };
      await walk(target);
      const result = textResult(lines.join('\n'), maxOutput, {
        filesSearched: Math.min(files, maxFiles),
        ...(instructionTexts.size ? { instructions: [...instructionTexts].join('\n\n') } : {}),
      });
      if (
        stopped &&
        result.structuredContent &&
        typeof result.structuredContent === 'object' &&
        !Array.isArray(result.structuredContent)
      )
        result.structuredContent.truncated = true;
      return result;
    }
  );
  return [read, write, edit, search];
}
/** Create the initial on-demand skill loader; disabled automatic invocation remains enforced by resources. */
export function createSkillTool(resources: Resources): ToolDescriptor {
  return {
    name: 'load_skill',
    description: 'Load an available skill by its qualified name.',
    schema: schema({ name: stringSchema }),
    initialLoad: true,
    execute: async (value, context) => {
      try {
        const args = object(value);
        const name = string(args.name, 'name');
        if (Object.keys(args).some((key) => key !== 'name')) throw new Error('Unknown argument');
        return textResult(await resources.loadSkill(name, context.signal), 256 * 1024);
      } catch (error) {
        return toolError(error);
      }
    },
  };
}
