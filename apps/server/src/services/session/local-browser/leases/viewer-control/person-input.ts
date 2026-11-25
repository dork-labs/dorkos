import { z } from 'zod';
import type { BrowserBrokerSource } from '../broker-source.js';
import type { BrowserPersonInput } from '../broker-contract.js';
import { LocalBrowserError } from '../../errors.js';
import { responseDeadline, ACTION_EFFECT_RESPONSE_TIMEOUT_MS } from '../../lifecycle.js';
import type { CDPSession } from 'playwright-core';
import { browserViewerInputSchema } from '@dorkos/shared/browser-viewer-control';
import {
  dispatchViewerInput,
  type ViewerInputMethod,
} from '../../../browser-viewers/input-dispatch.js';
import {
  readViewerSelection,
  selectionExpression,
} from '../../../browser-viewers/selection-copy.js';
import { readPersonSafety } from './person-safety.js';

const coordinate = z.number().finite().min(-100_000).max(100_000);
const button = z.enum(['left', 'middle', 'right']);
const legacyInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('move'), x: coordinate, y: coordinate }).strict(),
  z.object({ kind: z.literal('down'), button }).strict(),
  z.object({ kind: z.literal('up'), button }).strict(),
  z.object({ kind: z.literal('wheel'), deltaX: coordinate, deltaY: coordinate }).strict(),
  z.object({ kind: z.literal('keyDown'), key: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('keyUp'), key: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('text'), text: z.string().max(2_048) }).strict(),
]);
const inputSchema = z.union([browserViewerInputSchema, legacyInputSchema]);

/** One controller's finite input and held keys; another epoch cannot dispatch through it. */
export class BrowserPersonInputFlight {
  private pending?: Promise<void>;
  private readonly keys = new Set<string>();
  private readonly buttons = new Set<'left' | 'middle' | 'right'>();
  private protocol?: Promise<CDPSession>;
  private touch = false;
  private composition = false;
  private readonly protocolKeys = new Map<string, { key: string; code: string }>();
  private readonly protocolButtons = new Set<'left' | 'middle' | 'right'>();
  private pointer = { x: 0, y: 0 };

  constructor(
    private readonly source: BrowserBrokerSource,
    private readonly admit: () => void
  ) {}

  private async cdp(): Promise<CDPSession> {
    this.admit();
    this.protocol ??= this.source.work.track(
      this.source.page.context().newCDPSession(this.source.page)
    );
    const cdp = await this.protocol;
    this.admit();
    return cdp;
  }

  /** Fixed isolated-world read; it never invokes agent observation code. */
  readSafety(): Promise<'safe' | 'refused' | 'unknown'> {
    // runOperation retains the physical slot after its response deadline expires.
    return this.runOperation(async () => {
      const cdp = await this.cdp();
      this.admit();
      return readPersonSafety(cdp, this.admit, this.source.page.url());
    }, 1_000).catch(() => 'unknown');
  }

  /** Fixed isolated-world read; it never invokes agent observation code. */
  async readSelection(assertOperation?: () => void): Promise<string> {
    const admit = () => {
      this.admit();
      assertOperation?.();
    };
    if (this.pending)
      throw new LocalBrowserError('busy', 'A browser action is finishing. Wait a moment.');
    admit();
    return this.runOperation(async () => {
      const cdp = await this.cdp();
      admit();
      const tree = await cdp.send('Page.getFrameTree');
      admit();
      const world = await cdp.send('Page.createIsolatedWorld', {
        frameId: tree.frameTree.frame.id,
        worldName: 'dorkos-person-selection',
        grantUniveralAccess: false,
      });
      admit();
      return readViewerSelection({
        contextId: world.executionContextId,
        readFixedExpression: (contextId) =>
          cdp.send('Runtime.evaluate', {
            expression: selectionExpression,
            contextId,
            returnByValue: true,
            awaitPromise: false,
            disableBreaks: true,
          }),
        assertPersonControl: admit,
      });
    });
  }

  /** File consumption and selection share the controller's physical input slot. */
  async runOperation<T>(
    operation: () => Promise<T>,
    timeout = ACTION_EFFECT_RESPONSE_TIMEOUT_MS
  ): Promise<T> {
    this.admit();
    if (this.pending)
      throw new LocalBrowserError('busy', 'A browser action is finishing. Wait a moment.');
    const result = this.source.work.track(
      Promise.resolve().then(() => {
        this.admit();
        return operation();
      })
    );
    const pending = result.then(() => undefined);
    this.pending = pending;
    void pending
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      })
      .catch(() => undefined);
    return responseDeadline(
      result,
      timeout,
      () =>
        new LocalBrowserError(
          'uncertain',
          'The page is still finishing. Check it before continuing.'
        )
    );
  }

  /** No replay or hidden retry; a timed-out physical operation keeps its slot. */
  async run(
    input: BrowserPersonInput,
    admitted?: () => void,
    assertOperation?: () => void
  ): Promise<void> {
    this.admit();
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success)
      throw new LocalBrowserError('invalid_input', 'That browser input is not supported.');
    if (this.pending)
      throw new LocalBrowserError('busy', 'A browser action is finishing. Wait a moment.');
    if (input.kind === 'keyDown' && !this.keys.has(input.key) && this.keys.size >= 16)
      throw new LocalBrowserError('busy', 'Release a key before pressing another.');
    const pending = this.source.work.track(
      Promise.resolve().then(async () => {
        this.admit();
        await this.source.recordInput(parsed.data.kind);
        this.admit();
        assertOperation?.();
        admitted?.();
        await this.dispatch(parsed.data, assertOperation);
        this.admit();
      })
    );
    this.pending = pending;
    void pending
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      })
      .catch(() => undefined);
    await responseDeadline(
      pending,
      ACTION_EFFECT_RESPONSE_TIMEOUT_MS,
      () =>
        new LocalBrowserError(
          'uncertain',
          'The page is still finishing. Check it before continuing.'
        )
    );
  }

  /** Called only inside the page's custody barrier, after prior physical work drains. */
  async reset(): Promise<void> {
    await this.pending?.catch(() => undefined);
    if (this.source.page.isClosed()) {
      this.keys.clear();
      this.buttons.clear();
      this.protocolKeys.clear();
      this.protocolButtons.clear();
      if (this.protocol) await (await this.protocol).detach().catch(() => undefined);
      this.protocol = undefined;
      return;
    }
    for (const key of this.keys) {
      await this.source.work.track(this.source.page.keyboard.up(key));
      this.keys.delete(key);
    }
    for (const button of this.buttons) {
      await this.source.work.track(this.source.page.mouse.up({ button }));
      this.buttons.delete(button);
    }
    if (this.protocol) {
      const cdp = await this.protocol;
      const send = (method: ViewerInputMethod, params: Record<string, unknown>) =>
        this.source.work.track(sendPersonInput(cdp, method, params));
      for (const key of this.protocolKeys.values())
        await dispatchViewerInput({ send }, { kind: 'key', type: 'keyUp', ...key, modifiers: 0 });
      this.protocolKeys.clear();
      for (const button of this.protocolButtons) {
        await dispatchViewerInput(
          { send },
          { kind: 'pointer', type: 'mouseReleased', ...this.pointer, button, clickCount: 0 }
        );
        this.protocolButtons.delete(button);
      }
      if (this.touch)
        await dispatchViewerInput({ send }, { kind: 'touch', type: 'touchCancel', points: [] });
      if (this.composition)
        await dispatchViewerInput(
          { send },
          { kind: 'composition', text: '', selectionStart: 0, selectionEnd: 0 }
        );
      this.touch = this.composition = false;
      await cdp.detach();
      this.protocol = undefined;
    }
  }

  private async dispatch(input: BrowserPersonInput, assertOperation?: () => void): Promise<void> {
    assertOperation?.();
    const { page } = this.source;
    if (
      'type' in input ||
      input.kind === 'composition' ||
      (input.kind === 'wheel' && 'x' in input)
    ) {
      const cdp = await this.cdp();
      this.admit();
      assertOperation?.();
      if (input.kind === 'key') {
        if (input.type === 'keyDown') {
          if (this.protocolKeys.size >= 16 && !this.protocolKeys.has(input.code))
            throw Error('viewer_limit');
          this.protocolKeys.set(input.code, { key: input.key, code: input.code });
        }
      }
      if (input.kind === 'touch' && input.type !== 'touchEnd' && input.type !== 'touchCancel')
        this.touch = true;
      if (input.kind === 'composition' && input.text.length > 0) this.composition = true;
      if (input.kind === 'pointer') {
        this.pointer = { x: input.x, y: input.y };
        if (input.type === 'mousePressed' && input.button !== 'none')
          this.protocolButtons.add(input.button);
      }
      const held = new Set(this.protocolButtons);
      if (input.kind === 'pointer' && input.type === 'mouseReleased' && input.button !== 'none')
        held.delete(input.button);
      const buttons =
        (held.has('left') ? 1 : 0) | (held.has('right') ? 2 : 0) | (held.has('middle') ? 4 : 0);
      await dispatchViewerInput(
        {
          send: (method, params) => {
            this.admit();
            assertOperation?.();
            return sendPersonInput(cdp, method, params);
          },
        },
        input,
        buttons
      );
      if (input.kind === 'key' && input.type === 'keyUp') this.protocolKeys.delete(input.code);
      if (input.kind === 'pointer' && input.type === 'mouseReleased' && input.button !== 'none')
        this.protocolButtons.delete(input.button);
      if (input.kind === 'touch' && (input.type === 'touchEnd' || input.type === 'touchCancel'))
        this.touch = false;
      if (input.kind === 'composition' && input.text.length === 0) this.composition = false;
      return;
    }
    switch (input.kind) {
      case 'move':
        await page.mouse.move(input.x, input.y);
        break;
      case 'wheel':
        await page.mouse.wheel(input.deltaX, input.deltaY);
        break;
      case 'text':
        await page.keyboard.insertText(input.text);
        break;
      case 'down':
        this.buttons.add(input.button);
        await page.mouse.down({ button: input.button });
        break;
      case 'up':
        await page.mouse.up({ button: input.button });
        this.buttons.delete(input.button);
        break;
      case 'keyDown':
        this.keys.add(input.key);
        await page.keyboard.down(input.key);
        break;
      case 'keyUp':
        await page.keyboard.up(input.key);
        this.keys.delete(input.key);
        break;
    }
  }
}

/** Only schema-projected person input reaches these five literal protocol methods. */
function sendPersonInput(
  cdp: CDPSession,
  method: ViewerInputMethod,
  params: Record<string, unknown>
) {
  switch (method) {
    case 'Input.dispatchMouseEvent':
      return cdp.send(
        'Input.dispatchMouseEvent',
        params as Parameters<typeof cdp.send<'Input.dispatchMouseEvent'>>[1]
      );
    case 'Input.dispatchKeyEvent':
      return cdp.send(
        'Input.dispatchKeyEvent',
        params as Parameters<typeof cdp.send<'Input.dispatchKeyEvent'>>[1]
      );
    case 'Input.dispatchTouchEvent':
      return cdp.send(
        'Input.dispatchTouchEvent',
        params as Parameters<typeof cdp.send<'Input.dispatchTouchEvent'>>[1]
      );
    case 'Input.insertText':
      return cdp.send(
        'Input.insertText',
        params as Parameters<typeof cdp.send<'Input.insertText'>>[1]
      );
    case 'Input.imeSetComposition':
      return cdp.send(
        'Input.imeSetComposition',
        params as Parameters<typeof cdp.send<'Input.imeSetComposition'>>[1]
      );
  }
}
