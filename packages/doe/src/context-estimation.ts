import { createHash } from 'node:crypto';
import type { ModelMessage, ToolDescriptor, TokenEstimate } from './contracts.js';
/** Owned JSON-size heuristic; counts opaque fields instead of dropping them. */
export function estimateMessage(message: ModelMessage): number {
  return Math.ceil(JSON.stringify(message).length / 4);
}
/** Fold instruction sections, then explicitly select current schemas and host business prompt. */
export function currentSystem(
  messages: readonly ModelMessage[],
  prompt: string,
  tools: readonly ToolDescriptor[]
): ModelMessage {
  const sections: Record<string, string> = {};
  const content: string[] = [];
  const oldTools = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'system') continue;
    if (message.doeContextSnapshot === true) {
      content.length = 0;
      for (const key of Object.keys(sections)) delete sections[key];
      oldTools.clear();
    }
    const body =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter(
                (block) =>
                  block &&
                  typeof block === 'object' &&
                  !Array.isArray(block) &&
                  block.type === 'text' &&
                  typeof block.text === 'string'
              )
              .map((block) => (block as { text: string }).text)
              .join('\n')
          : '';
    if (body) content.push(body);
    const patch = message.sections;
    if (patch && typeof patch === 'object' && !Array.isArray(patch))
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete sections[key];
        else if (typeof value === 'string')
          Object.defineProperty(sections, key, {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
      }
    if (Array.isArray(message.toolsAdded))
      for (const declaration of message.toolsAdded)
        if (
          declaration &&
          typeof declaration === 'object' &&
          !Array.isArray(declaration) &&
          typeof declaration.name === 'string'
        )
          oldTools.add(declaration.name);
  }
  sections.doe = prompt;
  const selected = new Set(tools.map((tool) => tool.name));
  return {
    role: 'system',
    content: content.join('\n\n'),
    sections,
    toolsAdded: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: JSON.parse(JSON.stringify(tool.schema)),
    })),
    toolsRemoved: [...oldTools].filter((name) => !selected.has(name)).map((name) => ({ name })),
    timestamp: 0,
  };
}
/** Project the provider-facing input: one effective system plus complete non-system records. */
export function estimateInput(
  prompt: string,
  tools: readonly ToolDescriptor[],
  messages: readonly ModelMessage[]
): TokenEstimate {
  return {
    tokens:
      estimateMessage(currentSystem(messages, prompt, tools)) +
      messages
        .filter((message) => message.role !== 'system')
        .reduce((sum, message) => sum + estimateMessage(message), 0),
    source: 'estimated',
  };
}

/** A durable non-secret identity for the instruction/schema state used by a measured request. */
export function systemFingerprint(
  prompt: string,
  tools: readonly ToolDescriptor[],
  messages: readonly ModelMessage[]
): string {
  return createHash('sha256')
    .update(JSON.stringify(currentSystem(messages, prompt, tools)))
    .digest('hex');
}

/** Apply an owned checkpoint snapshot once; retain every non-system model record and later system updates. */
export function contextWithSnapshot(messages: readonly ModelMessage[]): ModelMessage[] {
  let snapshot = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'system' && messages[index].doeContextSnapshot === true) {
      snapshot = index;
      break;
    }
  }
  if (snapshot < 0) return [...messages];
  return [
    ...messages.slice(0, snapshot).filter((message) => message.role !== 'system'),
    ...messages.slice(snapshot),
  ];
}
