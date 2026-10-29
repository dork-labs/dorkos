/** Every room event is addressed; a new producer must not silently broadcast. */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventFanOut, type FanOutClient } from '../event-fan-out.js';
import { roomAudience } from '../../rooms/service/room-audience.js';

vi.mock('../auth/index.js', () => ({ readOwnerAccount: () => ({ id: 'owner' }) }));
vi.mock('../../rooms/operator-author.js', () => ({
  resolveOperatorAuthor: () => ({ id: 'owner-author' }),
}));

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}
const producers = sources(sourceRoot).flatMap((path) => {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const found: { name: string; path: string; addressed: boolean }[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['broadcast', 'broadcastRedacted'].includes(node.expression.name.text) &&
      node.expression.expression.getText(source) === 'eventFanOut'
    ) {
      const name = node.arguments[0];
      if (name && ts.isStringLiteral(name) && name.text.startsWith('room_')) {
        found.push({
          name: name.text,
          path,
          addressed: node.arguments.length === (node.expression.name.text === 'broadcast' ? 3 : 5),
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
});
const names = [...new Set(producers.map(({ name }) => name))];
const disconnect: (() => void)[] = [];
afterEach(() => disconnect.splice(0).forEach((off) => off()));
function stream(userId: string) {
  const send = vi.fn();
  const client: FanOutClient = { send, drop: vi.fn(), gone: false, bufferedBytes: 0 };
  disconnect.push(eventFanOut.addClient(client, { kind: 'program', userId }));
  return send;
}
const rooms = {
  authorRegistry: { human: (id: string) => ({ id }) } as Parameters<
    typeof roomAudience
  >[1]['authorRegistry'],
  requireMembership: (_roomId: string, authorId: string) => {
    if (authorId !== 'member') throw new Error('not a member');
  },
};

describe('every room_* event', () => {
  it('discovers the live event family', () => {
    expect(names).toEqual(
      expect.arrayContaining([
        'room_created',
        'room_updated',
        'room_member_added',
        'room_member_removed',
        'room_activity',
        'room_presence',
        'room_awaiting',
      ])
    );
  });
  for (const name of names) {
    for (const method of ['broadcast', 'broadcastRedacted'] as const) {
      it(`${method} ${name}: only addressed members receive either rendering`, () => {
        for (const producer of producers.filter((p) => p.name === name)) {
          expect(producer.addressed, producer.path).toBe(true);
        }
        const member = stream('member');
        const outsider = stream('outsider');
        const publish = (audience?: ReturnType<typeof roomAudience>) => {
          // Deliberately bypass types to exercise untyped callers at the runtime boundary.
          if (method === 'broadcast')
            Reflect.apply(eventFanOut.broadcast, eventFanOut, [name, { roomId: 'room' }, audience]);
          else
            Reflect.apply(eventFanOut.broadcastRedacted, eventFanOut, [
              name,
              { roomId: 'room', full: true },
              { roomId: 'room', full: false },
              () => false,
              audience,
            ]);
        };
        publish(roomAudience('room', rooms));
        expect(member).toHaveBeenCalledOnce();
        expect(outsider).not.toHaveBeenCalled();
        member.mockClear();
        publish();
        expect(member).not.toHaveBeenCalled();
        expect(outsider).not.toHaveBeenCalled();
        // The same audience restriction also applies to the full rendering.
        if (method === 'broadcastRedacted') {
          eventFanOut.broadcastRedacted(name, {}, {}, () => true, roomAudience('room', rooms));
          expect(member).toHaveBeenCalledOnce();
          expect(outsider).not.toHaveBeenCalled();
        }
      });
    }
  }
  it('includes only the removed member alongside remaining members in a removal notice', () => {
    const member = stream('member');
    const removed = stream('removed');
    const outsider = stream('outsider');
    eventFanOut.broadcast(
      'room_member_removed',
      { roomId: 'room', authorId: 'removed' },
      roomAudience('room', rooms, 'removed')
    );
    expect(member).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledOnce();
    expect(outsider).not.toHaveBeenCalled();
    removed.mockClear();
    eventFanOut.broadcast('room_updated', { roomId: 'room' }, roomAudience('room', rooms));
    expect(removed).not.toHaveBeenCalled();
  });
});

it('requires room and dynamic audiences at compile time in both APIs', () => {
  const path = join(sourceRoot, 'services/core/event-fan-out.ts');
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const service = source.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === 'EventFanOut'
  )!;
  const aliases = source.statements
    .filter(
      (node): node is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(node) &&
        ['ScopedEventName', 'UnscopedEventName'].includes(node.name.text)
    )
    .map((node) => node.getText(source))
    .join('\n');
  const signatures = service.members
    .filter(
      (node): node is ts.MethodDeclaration =>
        ts.isMethodDeclaration(node) &&
        !node.body &&
        ['broadcast', 'broadcastRedacted'].includes(node.name.getText(source))
    )
    .map((node) => node.getText(source))
    .join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'room-event-types-'));
  try {
    const fixture = join(dir, 'scope.ts');
    const cases = ['broadcast', 'broadcastRedacted']
      .flatMap((method) => {
        const payload = method === 'broadcast' ? '{}' : '{}, {}, () => true';
        return [
          `fan.${method}('session_status', ${payload});`,
          `fan.${method}(nonRoom, ${payload});`,
          `fan.${method}('room_created', ${payload}, () => true);`,
          `fan.${method}(room, ${payload}, () => true);`,
          `fan.${method}(dynamic, ${payload}, () => true);`,
          `fan.${method}(mixed, ${payload}, () => true);`,
          `fan.${method}(openPrefix, ${payload}, () => true);`,
          `fan.${method}(openSuffix, ${payload}, () => true);`,
          `fan.${method}(mixedOpenPrefix, ${payload}, () => true);`,
          `fan.${method}(mixedOpenSuffix, ${payload}, () => true);`,
          `// @ts-expect-error A room audience is mandatory.\nfan.${method}('room_created', ${payload});`,
          `// @ts-expect-error Undefined is not a room audience.\nfan.${method}(room, ${payload}, undefined);`,
          `// @ts-expect-error A dynamic string could name a room event.\nfan.${method}(dynamic, ${payload});`,
          `// @ts-expect-error An open prefix can name a room event.\nfan.${method}(openPrefix, ${payload});`,
          `// @ts-expect-error An open suffix can name a room event.\nfan.${method}(openSuffix, ${payload});`,
          `// @ts-expect-error An open member makes the whole union unsafe.\nfan.${method}(mixedOpenPrefix, ${payload});`,
          `// @ts-expect-error A suffix member makes the whole union unsafe.\nfan.${method}(mixedOpenSuffix, ${payload});`,
          `// @ts-expect-error A mixed union can name a room event.\nfan.${method}(mixed, ${payload});`,
        ];
      })
      .join('\n');
    writeFileSync(
      fixture,
      `type Record<K extends string, V> = { [P in K]: V };
      type Extract<T, U> = T extends U ? T : never;
      type BroadcastAudience = () => boolean;
      ${aliases}
      declare class Fan { ${signatures} }
      declare const fan: Fan;
      declare const room: \`room_\${string}\`;
      declare const openPrefix: \`room\${string}\`;
      declare const openSuffix: \`\${string}_created\`;
      declare const mixedOpenPrefix: 'session_status' | \`room\${string}\`;
      declare const mixedOpenSuffix: 'relay_signal' | \`\${string}_created\`;
      declare const dynamic: string;
      declare const mixed: 'room_created' | 'session_status';
      declare const nonRoom: 'relay_signal' | 'session_status';
      ${cases}`
    );
    const program = ts.createProgram([fixture], {
      strict: true,
      noEmit: true,
      noLib: true,
      types: [],
    });
    // No standard library is loaded: its unrelated global declarations are intentionally absent.
    const errors = ts.getPreEmitDiagnostics(program).filter((error) => error.code !== 2318);
    expect(errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))).toEqual(
      []
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
