import { randomBytes } from 'node:crypto';
import type { BrowserViewerChooser } from '@dorkos/shared/browser-viewer-control';

export interface ChooserFacts {
  controllerId: string;
  navigationGeneration: number;
  controlEpoch: number;
  host: string;
  elementId?: string;
}
interface Ticket extends BrowserViewerChooser {
  facts: ChooserFacts;
  expires: number;
}
const same = (a: ChooserFacts, b: ChooserFacts) =>
  a.controllerId === b.controllerId &&
  a.navigationGeneration === b.navigationGeneration &&
  a.controlEpoch === b.controlEpoch &&
  a.host === b.host;

/** Volatile one-use chooser policy. Facts arrive only after real broker admission. */
export class ViewerChooserTickets {
  private activation?: { facts: ChooserFacts; at: number };
  private readonly tickets = new Map<string, Ticket>();
  constructor(private readonly now = () => performance.now()) {}
  admittedInput(facts: ChooserFacts): void {
    this.activation = { facts: { ...facts }, at: this.now() };
  }
  open(facts: ChooserFacts & { multiple: boolean }): BrowserViewerChooser {
    const activation = this.activation;
    this.activation = undefined;
    if (!activation || this.now() - activation.at > 1_000 || !same(activation.facts, facts))
      throw Error('viewer_denied');
    this.clear();
    const ticket: Ticket = {
      id: randomBytes(32).toString('base64url'),
      host: facts.host,
      multiple: facts.multiple,
      navigationGeneration: facts.navigationGeneration,
      facts: { ...facts },
      expires: this.now() + 60_000,
    };
    this.tickets.set(ticket.id, ticket);
    const { facts: _facts, expires: _expires, ...publicTicket } = ticket;
    return publicTicket;
  }
  consume(
    id: string,
    facts: ChooserFacts,
    files: readonly { name: string; bytes: Uint8Array }[] | undefined
  ): void {
    const ticket = this.tickets.get(id);
    this.tickets.delete(id);
    if (
      !ticket ||
      this.now() >= ticket.expires ||
      !same(ticket.facts, facts) ||
      !files?.length ||
      files.length > (ticket.multiple ? 10 : 1)
    )
      throw Error('viewer_denied');
    let bytes = 0;
    for (const file of files) {
      if (
        !file.name ||
        file.name.length > 255 ||
        /[\\/]/.test(file.name) ||
        [...file.name].some((character) => character.charCodeAt(0) < 32) ||
        file.name === '.' ||
        file.name === '..' ||
        !(file.bytes instanceof Uint8Array)
      )
        throw Error('viewer_denied');
      bytes += file.bytes.byteLength;
    }
    if (bytes > 25 * 1024 * 1024) throw Error('viewer_limit');
  }
  cancel(id: string): void {
    this.tickets.delete(id);
  }
  clear(): void {
    this.tickets.clear();
    this.activation = undefined;
  }
}
