import type { BrowserBrokerSource } from '../broker-source.js';
import type {
  BrowserPersonFile,
  BrowserPersonInput,
  BrowserPersonPaint,
} from '../broker-contract.js';
import { BrowserPersonInputFlight } from './person-input.js';
import { BrowserPersonFiles } from './person-files.js';
import { LocalBrowserError } from '../../errors.js';

/** Physical work captures one document generation; no await can adopt a later document. */
export class BrowserPersonGeneration {
  readonly input: BrowserPersonInputFlight;
  readonly files: BrowserPersonFiles;
  private safe = false;
  private painted = false;
  constructor(
    private readonly source: BrowserBrokerSource,
    readonly generation: number,
    private readonly assertController: () => void,
    controllerId: string,
    private readonly owner: string,
    private readonly fileOperations: Map<string, number>
  ) {
    this.input = new BrowserPersonInputFlight(source, this.assertCurrent);
    this.files = new BrowserPersonFiles(source, this.assertCurrent, controllerId);
  }
  readonly assertCurrent = (): void => {
    this.assertController();
    if (
      this.source.facts().navigationGeneration !== this.generation ||
      !this.source.protectionAllowed()
    )
      throw stale();
  };
  readonly admit = (): void => {
    this.assertCurrent();
    if (!this.safe || !this.painted) throw stale();
  };
  ready(): boolean {
    try {
      this.admit();
      return true;
    } catch {
      return false;
    }
  }
  async initialize(): Promise<void> {
    this.assertCurrent();
    const verdict = await this.input.readSafety();
    this.assertCurrent();
    if (verdict !== 'safe')
      throw new LocalBrowserError('viewer_unavailable', 'The page cannot be controlled here.');
    this.safe = true;
  }
  confirmPaint(paint: BrowserPersonPaint): void {
    this.assertCurrent();
    if (
      !this.safe ||
      paint.navigationGeneration !== this.generation ||
      paint.addressGeneration !== this.generation ||
      !Number.isSafeInteger(paint.viewportGeneration) ||
      paint.viewportGeneration < 1
    )
      throw stale();
    this.painted = true;
  }
  async run(event: BrowserPersonInput): Promise<void> {
    this.admit();
    await this.source.authorize();
    this.admit();
    await this.input.run(event, () => this.files.admittedInput());
    await this.source.authorize();
    this.admit();
  }
  async readSelection(): Promise<string> {
    this.admit();
    await this.source.authorize();
    this.admit();
    const text = await this.input.readSelection();
    await this.source.authorize();
    this.admit();
    return text;
  }
  async chooseFiles(id: string, payloads: readonly BrowserPersonFile[]): Promise<void> {
    let reserved = false;
    let started = false;
    const release = () => {
      const remaining = (this.fileOperations.get(this.owner) ?? 1) - 1;
      if (remaining) this.fileOperations.set(this.owner, remaining);
      else this.fileOperations.delete(this.owner);
    };
    try {
      this.admit();
      const count = this.fileOperations.get(this.owner) ?? 0;
      if (count >= 2)
        throw new LocalBrowserError('busy', 'Two file selections are finishing. Wait a moment.');
      this.fileOperations.set(this.owner, count + 1);
      reserved = true;
      await this.input.runOperation(async () => {
        started = true;
        try {
          await this.files.choose(id, payloads);
        } finally {
          release();
        }
      });
    } finally {
      if (!started) {
        if (reserved) release();
        for (const payload of payloads) payload.buffer.fill(0);
      }
    }
  }
  async reset(): Promise<void> {
    this.safe = this.painted = false;
    try {
      await this.files.dispose();
    } finally {
      await this.input.reset();
    }
  }
}

function stale(): LocalBrowserError {
  return new LocalBrowserError('stale_page', 'The page changed. Wait for its current view.');
}
