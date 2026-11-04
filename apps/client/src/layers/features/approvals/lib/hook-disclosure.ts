/** Read only the server's complete, quoted disclosure; never reconstruct it from a title. */
export function readHookDisclosure(detail?: string) {
  if (!detail) return undefined;
  const [header, ...sections] = detail.split('\n\n');
  const head = header.split('\n');
  if (
    head.length !== 2 ||
    !head[0].startsWith('Package: ') ||
    !head[1].startsWith('Working directory: ')
  )
    return undefined;
  const hooks: { event: string; matcher: string; command: string }[] = [];
  const files: { file: string; hash: string }[] = [];
  for (const section of sections) {
    const lines = section.split('\n');
    if (
      lines[0] === `Hook ${hooks.length + 1}` &&
      lines.length === 4 &&
      lines[1].startsWith('Event: ') &&
      lines[2].startsWith('Matcher: ') &&
      lines[3].startsWith('Command: ')
    ) {
      hooks.push({
        event: lines[1].slice(7),
        matcher: lines[2].slice(9),
        command: lines[3].slice(9),
      });
    } else if (
      lines.length === 2 &&
      lines[0].startsWith('File: ') &&
      lines[1].startsWith('Fingerprint: ')
    ) {
      files.push({ file: lines[0].slice(6), hash: lines[1].slice(13) });
    } else return undefined;
  }
  return hooks.length
    ? { package: head[0].slice(9), directory: head[1].slice(19), hooks, files }
    : undefined;
}

const WHEN: Record<string, string> = {
  PreToolUse: 'Before a tool call',
  PostToolUse: 'After every tool call',
  PostToolUseFailure: 'After a tool call stops with an error',
  Stop: 'When the agent finishes',
  SessionStart: 'When a chat starts',
  SessionEnd: 'When a chat ends',
  UserPromptSubmit: 'When you send a message',
  PreCompact: 'Before chat history is shortened',
  Notification: 'When the agent sends a notification',
  SubagentStart: 'When another agent starts',
  SubagentStop: 'When another agent finishes',
  PermissionRequest: 'When a tool asks permission',
};

/** A known event gets plain words; its exact quoted name remains on the card. */
export function hookWhen(event: string): string {
  try {
    const name: unknown = JSON.parse(event);
    return typeof name === 'string' && Object.hasOwn(WHEN, name)
      ? WHEN[name]
      : 'When this event happens';
  } catch {
    return 'When this event happens';
  }
}
