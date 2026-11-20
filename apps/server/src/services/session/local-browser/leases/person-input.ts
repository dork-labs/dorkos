import { z } from 'zod';
import type { BrowserBrokerSource } from './broker-source.js';
import type { BrowserPersonInput } from './broker-contract.js';
import { LocalBrowserError } from '../errors.js';
import { responseDeadline, ACTION_EFFECT_RESPONSE_TIMEOUT_MS } from '../lifecycle.js';

const coordinate = z.number().finite().min(-100_000).max(100_000);
const button = z.enum(['left', 'middle', 'right']);
const inputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('move'), x: coordinate, y: coordinate }).strict(),
  z.object({ kind: z.literal('down'), button }).strict(),
  z.object({ kind: z.literal('up'), button }).strict(),
  z.object({ kind: z.literal('wheel'), deltaX: coordinate, deltaY: coordinate }).strict(),
  z.object({ kind: z.literal('keyDown'), key: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('keyUp'), key: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('text'), text: z.string().max(2_048) }).strict(),
]);

/** One controller's finite input and held keys; another epoch cannot dispatch through it. */
export class BrowserPersonInputFlight {
  private pending?: Promise<void>;
  private readonly keys = new Set<string>();
  private readonly buttons = new Set<'left' | 'middle' | 'right'>();

  constructor(
    private readonly source: BrowserBrokerSource,
    private readonly admit: () => void
  ) {}

  /** No replay or hidden retry; a timed-out physical operation keeps its slot. */
  async run(input: BrowserPersonInput): Promise<void> {
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
        await this.dispatch(parsed.data);
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
  }

  private async dispatch(input: BrowserPersonInput): Promise<void> {
    const { page } = this.source;
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
