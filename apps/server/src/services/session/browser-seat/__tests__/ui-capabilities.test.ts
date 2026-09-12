/**
 * What the `ui` domain ADVERTISES: every verb, the arguments a model may send
 * it, the surface it reaches, and the tier that gates it (spec
 * `canvas-agent-seat` §5).
 *
 * ## Two different guards live here, and they catch different things
 *
 * A capability's `input` is read at MODULE scope, and this domain reads its
 * schemas out of sibling modules. When one of those siblings imported the
 * `core/capabilities` barrel it closed an import cycle, `z.object(undefined)`
 * produced an EMPTY shape, and `browser_read_console` and `browser_read_network`
 * advertised no arguments at all — so `level`, `status` and `limit` were
 * stripped on the way in and every read answered with the default. Nothing
 * threw; nothing was red.
 *
 * **The structural check is what pins that**, and it is the one to keep: a cycle
 * only empties a schema for SOME entry orders, so a value-based assertion that
 * reds today can go quiet tomorrow because an unrelated file changed which
 * module initializes first. Measured, twice, on this very file: re-seeding the
 * barrel import reddened the argument table in one arrangement of this domain's
 * modules and left it green in the next. Do not read the argument table as the
 * cycle's guard.
 *
 * **The argument table is worth having for its own sake**: it is what the model
 * is told it may send, and nothing else states it. A verb that loses or gains an
 * argument — for any reason, cycle or not — is a line to look at here.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { noopLogger } from '@dorkos/shared/logger';
// **These two imports come FIRST on purpose, and the order is the test.**
// Evaluating a schema-providing sibling before the `core/capabilities` barrel is
// the exact order that used to leave this domain holding an empty shape (see the
// module doc). Reorder them below the barrel and the argument case stops being
// able to fail.
import { READ_CONSOLE_INPUT, READ_NETWORK_INPUT } from '../devtools-reads.js';
import { CLICK_INPUT } from '../driving-contract.js';
import { composeRegistry } from '../../../core/capabilities/index.js';
import { uiDomain } from '../ui-capabilities.js';

/** Every `ui` verb: its tool name, its tier, and the arguments it takes. */
const EXPECTED: Record<string, { tool: string; tier: string; args: string[] }> = {
  'ui.control': {
    tool: 'control_ui',
    tier: 'act',
    args: [
      'action',
      'panel',
      'tab',
      'content',
      'documentId',
      'sourcePath',
      'url',
      'preferredWidth',
      'message',
      'level',
      'description',
      'theme',
      'messageId',
      'title',
      'shape',
      'cwd',
      'kind',
      'emoji',
      // Last, because that is where `CONTROL_UI_INPUT` declares it (spec
      // `canvas-agent-seat` §9). This list is compared with `toEqual`, so a new
      // field goes at the index the constant puts it, never appended for
      // convenience.
      'target',
    ],
  },
  'ui.state': { tool: 'get_ui_state', tier: 'observe', args: [] },
  'ui.read_canvas_document': {
    tool: 'read_canvas_document',
    tier: 'observe',
    args: ['documentId'],
  },
  'ui.read_console': { tool: 'browser_read_console', tier: 'observe', args: ['level', 'limit'] },
  'ui.read_network': { tool: 'browser_read_network', tier: 'observe', args: ['status', 'limit'] },
  'ui.screenshot': { tool: 'browser_screenshot', tier: 'act', args: [] },
  'ui.click': {
    tool: 'browser_click',
    tier: 'act',
    args: ['documentId', 'role', 'name', 'text', 'selector', 'nth'],
  },
  'ui.type': {
    tool: 'browser_type',
    tier: 'act',
    args: ['documentId', 'role', 'name', 'selector', 'nth', 'text', 'clear', 'submit'],
  },
  'ui.press': { tool: 'browser_press', tier: 'act', args: ['documentId', 'key'] },
  'ui.scroll': {
    tool: 'browser_scroll',
    tier: 'act',
    args: ['documentId', 'role', 'name', 'text', 'selector', 'nth', 'by', 'to'],
  },
  'ui.wait_for': {
    tool: 'browser_wait_for',
    tier: 'observe',
    args: ['documentId', 'text', 'selector', 'gone', 'fetchIdle', 'timeoutMs'],
  },
  'ui.read_page': { tool: 'browser_read_page', tier: 'observe', args: ['documentId', 'selector'] },
  'ui.record_start': { tool: 'browser_record_start', tier: 'act', args: ['documentId'] },
  'ui.record_stop': { tool: 'browser_record_stop', tier: 'act', args: [] },
};

const registry = composeRegistry([uiDomain], { logger: noopLogger });

describe('the `ui` capability domain', () => {
  it('declares exactly these verbs, and no others', () => {
    expect(registry.capabilities.map((c) => c.id).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('advertises the arguments each verb really takes', () => {
    for (const [id, expected] of Object.entries(EXPECTED)) {
      const capability = registry.get(id);
      expect(capability, id).toBeDefined();
      const shape = (capability!.input as z.ZodObject<z.ZodRawShape>).shape;
      expect(Object.keys(shape), `${id} advertises the wrong arguments`).toEqual(expected.args);
    }
  });

  it('advertises the SAME arguments the schema modules declare', () => {
    // The other half of the case above: compared against the sibling's own
    // constant rather than against a copy of its key list, so a rename in the
    // schema module is caught without editing the table above.
    const shapeOf = (id: string) =>
      Object.keys((registry.get(id)!.input as z.ZodObject<z.ZodRawShape>).shape);
    expect(shapeOf('ui.read_console')).toEqual(Object.keys(READ_CONSOLE_INPUT));
    expect(shapeOf('ui.read_network')).toEqual(Object.keys(READ_NETWORK_INPUT));
    expect(shapeOf('ui.click')).toEqual(Object.keys(CLICK_INPUT));
  });

  it('reads no schema through the `core/capabilities` barrel', () => {
    // **The pin for the cycle**, and the only one that holds whatever order the
    // modules happen to initialize in: a module this domain reads a schema out
    // of must not pull the barrel, which closes a loop back here. The leaf
    // modules under `core/capabilities/` are fine — it is the barrel that is the
    // loop. Re-seed that import and this reds; the argument table above may or
    // may not, which is exactly why the rule is stated structurally.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const seat = path.resolve(here, '..');
    const offenders = readdirSync(seat)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) =>
        readFileSync(path.join(seat, name), 'utf-8').includes(
          "from '../../core/capabilities/index.js'"
        )
      )
      // `ui-capabilities.ts` is the domain itself: it reads no schema out of the
      // barrel, and it is the module the cycle would come BACK to.
      .filter((name) => name !== 'ui-capabilities.ts');
    expect(
      offenders,
      'these import the capabilities BARREL, which closes a cycle back into this domain and ' +
        'empties a module-scope schema. Import the leaf module instead.'
    ).toEqual([]);
  });

  it('names each verb what the model already calls it, at the tier it already had', () => {
    for (const [id, expected] of Object.entries(EXPECTED)) {
      const mcp = registry.get(id)!.surfaces.mcp;
      expect(mcp?.toolName, id).toBe(expected.tool);
      expect(registry.get(id)!.tier, id).toBe(expected.tier);
    }
  });

  it('reaches the in-session surface and no other', () => {
    // A verb that acts inside somebody's preview has to know whose window is
    // holding it, and the external `/mcp` surface is session-less by
    // construction. Nothing here may reach it.
    for (const capability of registry.capabilities) {
      expect(capability.surfaces.mcp?.servers, capability.id).toEqual(['in-session']);
      expect(capability.surfaces.http, capability.id).toBeUndefined();
      expect(capability.surfaces.cli, capability.id).toBeUndefined();
    }
  });

  it('is the ONLY implementation — the hand-registered copies are gone', () => {
    // "One implementation per tool" in the only form that cannot rot: the files
    // that held the other copies do not exist. A wrapper that merely delegates
    // would be a second description, a second input schema and a second place to
    // forget — which is what `control_ui` had three of before this (spec
    // `canvas-agent-seat` §5).
    const here = path.dirname(fileURLToPath(import.meta.url));
    const server = path.resolve(here, '../../../..');
    const retired = [
      'services/runtimes/claude-code/mcp-tools/ui-tools.ts',
      'services/runtimes/claude-code/mcp-tools/devtools-tools.ts',
      'services/runtimes/claude-code/mcp-tools/browser-driving-tools.ts',
      'services/runtimes/codex/codex-ui-mcp-server.ts',
      'services/runtimes/codex/ui-command-consent.ts',
    ];
    const survivors = retired.filter((file) => existsSync(path.join(server, file)));
    expect(
      survivors,
      'these held a second copy of a `ui` verb. The domain is the implementation now.'
    ).toEqual([]);
    // The subject, asserted before the verdict: a wrong base path would make the
    // check above vacuously green.
    expect(existsSync(path.join(server, 'services/session/browser-seat/ui-capabilities.ts'))).toBe(
      true
    );
  });

  it('claims no read-only carve-out, so none of it answers a tokenless caller', () => {
    for (const capability of registry.capabilities) {
      expect(capability.surfaces.mcp?.readOnlyCarveOut, capability.id).toBeFalsy();
    }
  });
});
