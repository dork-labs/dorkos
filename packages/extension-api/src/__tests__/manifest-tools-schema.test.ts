/**
 * The `tools` and `skills` declarations in `extension.json` (DOR-2685, task
 * 2.1). Discovery and `dorkos marketplace validate` both parse with this one
 * schema, so what it refuses here is refused everywhere a manifest is read.
 */
import { describe, it, expect } from 'vitest';
import { EXTENSION_MCP_TOOL_NAME_MAX } from '@dorkos/shared/capabilities';
import { ExtensionManifestSchema } from '../manifest-schema.js';

/** A tool declaration that passes, for cases to bend one field of. */
function sendTool(overrides: Record<string, unknown> = {}) {
  return {
    name: 'send_message',
    title: 'Send an email',
    description: 'Send an email from the person’s mail account.',
    tier: 'act',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, subject: { type: 'string' } },
      required: ['to'],
      additionalProperties: false,
    },
    approvalDisplayFields: ['to', 'subject'],
    ...overrides,
  };
}

/** A manifest with a server entry and the given extra fields. */
function manifest(extra: Record<string, unknown>) {
  return {
    id: 'mail-app',
    name: 'Mail',
    version: '1.0.0',
    serverCapabilities: { serverEntry: './server.ts' },
    ...extra,
  };
}

/** Every issue message, for asserting a refusal names what it refused. */
function messages(input: unknown): string[] {
  const result = ExtensionManifestSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('ExtensionManifestSchema tools and skills', () => {
  it('parses a manifest declaring tools and skills, defaulting the timeout', () => {
    // Purpose: the happy path an author writes, and the 60-second default the
    // invoke wrapper relies on when the field is left out.
    const result = ExtensionManifestSchema.safeParse(
      manifest({ tools: [sendTool()], skills: ['triage-inbox'] })
    );
    expect(result.success).toBe(true);
    expect(result.data?.tools?.[0]?.timeoutSeconds).toBe(60);
    expect(result.data?.skills).toEqual(['triage-inbox']);
  });

  it('keeps capabilities meaning event subscriptions beside tools', () => {
    // Purpose: Decision for Dorian 3 — `tools` is a new key; the existing
    // `capabilities` key still declares events and nothing else.
    const result = ExtensionManifestSchema.safeParse(
      manifest({ tools: [sendTool()], capabilities: { events: ['session'] } })
    );
    expect(result.success).toBe(true);
    expect(result.data?.capabilities).toEqual({ events: ['session'] });
  });

  it('refuses tools on an extension with no server entry', () => {
    // Purpose: a tool needs `ctx.tools.handle` in server.ts; a client-only or
    // proxy-only extension declaring one could never answer it.
    const { serverCapabilities: _none, ...clientOnly } = manifest({ tools: [sendTool()] });
    expect(messages(clientOnly).join('\n')).toMatch(/Tools need a server entry/);
  });

  it('refuses a tool name declared twice', () => {
    // Purpose: two handlers could not be told apart, and the registry would
    // refuse the whole contribution later; refuse it while parsing instead.
    expect(messages(manifest({ tools: [sendTool(), sendTool()] })).join('\n')).toMatch(
      /"send_message" is declared more than once/
    );
  });

  it.each([
    ['a double underscore', 'send__message'],
    ['a leading underscore', '_send'],
    ['a trailing underscore', 'send_'],
    ['an uppercase letter', 'Send'],
    ['a hyphen', 'send-message'],
  ])('refuses a tool name with %s', (_label, name) => {
    // Purpose: the first `__` in `ext_<id>__<tool>` must mark where the
    // extension ends, and the registry uses this exact pattern.
    expect(messages(manifest({ tools: [sendTool({ name })] })).join('\n')).toMatch(
      /lowercase letters and digits/
    );
  });

  it('refuses an approval display field the input does not have', () => {
    // Purpose: the card would show a field that is never there.
    expect(
      messages(manifest({ tools: [sendTool({ approvalDisplayFields: ['to', 'cc'] })] })).join('\n')
    ).toMatch(/shows "cc" on its approval card, but its input has no such property/);
  });

  it('refuses a tool whose full MCP name is over the limit, naming the budget', () => {
    // Purpose: `mcp__dorkos__ext_<id>__<tool>` over 64 characters fails every
    // turn of every session that lists it. A 70-character qualified name.
    const name = 'a'.repeat(70 - 'mcp__dorkos__ext_mail_app__'.length);
    const text = messages(manifest({ tools: [sendTool({ name })] })).join('\n');
    expect(text).toMatch(new RegExp(`at most ${EXTENSION_MCP_TOOL_NAME_MAX}`));
    expect(text).toContain(`Tool "${name}"`);
  });

  it('accepts a name exactly at the limit', () => {
    // Purpose: the bound is inclusive, so the check above is not off by one.
    const name = 'a'.repeat(EXTENSION_MCP_TOOL_NAME_MAX - 'ext_mail_app__'.length);
    expect(messages(manifest({ tools: [sendTool({ name })] }))).toEqual([]);
  });

  it.each([0, 301, 1.5])('refuses timeoutSeconds %s', (timeoutSeconds) => {
    // Purpose: the manifest cannot turn the deadline off or stretch it past
    // five minutes.
    expect(
      ExtensionManifestSchema.safeParse(manifest({ tools: [sendTool({ timeoutSeconds })] })).success
    ).toBe(false);
  });

  it('refuses an input schema whose root is not an object', () => {
    // Purpose: every agent tool takes named arguments.
    expect(
      ExtensionManifestSchema.safeParse(
        manifest({ tools: [sendTool({ inputSchema: { type: 'string' } })] })
      ).success
    ).toBe(false);
  });

  it('refuses an unknown tier', () => {
    // Purpose: the gate only knows observe, act and destructive.
    expect(
      ExtensionManifestSchema.safeParse(manifest({ tools: [sendTool({ tier: 'admin' })] })).success
    ).toBe(false);
  });

  it.each(['Triage', 'triage--inbox', '-triage', 'triage_inbox', ''])(
    'refuses the skill name %j',
    (skill) => {
      // Purpose: the SKILL.md naming rule from @dorkos/skills, read from there.
      expect(messages(manifest({ skills: [skill] })).join('\n')).toMatch(/lowercase letters/);
    }
  );

  it('refuses a skill listed twice', () => {
    // Purpose: one folder, one projection.
    expect(messages(manifest({ skills: ['triage', 'triage'] })).join('\n')).toMatch(
      /listed more than once/
    );
  });
});
