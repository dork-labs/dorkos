import { describe, expect, it } from 'vitest';
import { ViewerChooserTickets } from '../chooser-tickets.js';

// These are server facts after admission, not a stand-in for lease authorization.
const facts = {
  controllerId: 'person-a',
  navigationGeneration: 3,
  controlEpoch: 4,
  host: 'files.example',
};
function fixture() {
  let time = 1_000;
  const tickets = new ViewerChooserTickets(() => time);
  return {
    tickets,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('chooser activation and fresh selection (P3)', () => {
  it.each(['../file', '/tmp/file', 'folder/file', 'folder\\file', '\u0000file'])(
    'refuses a path-like or control name %s',
    (name) => {
      const { tickets } = fixture();
      tickets.admittedInput(facts);
      const ticket = tickets.open({ ...facts, multiple: false });
      expect(() =>
        tickets.consume(ticket.id, facts, [{ name, bytes: new Uint8Array([1]) }])
      ).toThrow();
    }
  );

  it('bounds aggregate file bytes and file count', () => {
    const { tickets } = fixture();
    tickets.admittedInput(facts);
    const first = tickets.open({ ...facts, multiple: true });
    expect(() =>
      tickets.consume(first.id, facts, [
        { name: 'large', bytes: new Uint8Array(25 * 1024 * 1024 + 1) },
      ])
    ).toThrow();
    tickets.admittedInput(facts);
    const second = tickets.open({ ...facts, multiple: true });
    expect(() =>
      tickets.consume(
        second.id,
        facts,
        Array.from({ length: 11 }, (_, index) => ({
          name: String(index),
          bytes: new Uint8Array([1]),
        }))
      )
    ).toThrow();
  });
  it('refuses a chooser before admitted person input', () => {
    const { tickets } = fixture();
    expect(() => tickets.open({ ...facts, multiple: false })).toThrow();
  });

  it('expires admitted-input activation independently of the chooser ticket', () => {
    const { tickets, advance } = fixture();
    tickets.admittedInput(facts);
    advance(1_001);
    expect(() => tickets.open({ ...facts, multiple: false })).toThrow();
  });

  it('names the authoritative host and single/multiple policy, without requiring the clicked element', () => {
    const { tickets } = fixture();
    tickets.admittedInput({ ...facts, elementId: 'button-a' });
    const ticket = tickets.open({ ...facts, elementId: 'different-file-input', multiple: true });
    expect(ticket).toMatchObject({ host: 'files.example', multiple: true });
    expect(ticket).not.toHaveProperty('files');
  });

  it.each(['controllerId', 'navigationGeneration', 'controlEpoch', 'host'] as const)(
    'refuses changed %s before minting a ticket',
    (key) => {
      const { tickets } = fixture();
      tickets.admittedInput(facts);
      const changed = { ...facts, [key]: typeof facts[key] === 'number' ? 99 : 'different' };
      expect(() => tickets.open({ ...changed, multiple: false })).toThrow();
    }
  );

  it('requires a fresh explicit selection and consumes the ticket once', () => {
    const { tickets } = fixture();
    tickets.admittedInput(facts);
    const ticket = tickets.open({ ...facts, multiple: false });
    expect(() => tickets.consume(ticket.id, facts, undefined)).toThrow();
    tickets.admittedInput(facts);
    const selected = tickets.open({ ...facts, multiple: false });
    tickets.consume(selected.id, facts, [{ name: 'made-up.txt', bytes: new Uint8Array([1]) }]);
    expect(() =>
      tickets.consume(selected.id, facts, [{ name: 'again.txt', bytes: new Uint8Array([2]) }])
    ).toThrow();
    tickets.admittedInput(facts);
    const next = tickets.open({ ...facts, multiple: false });
    expect(next).not.toHaveProperty('files');
    expect(() => tickets.consume(next.id, facts, undefined)).toThrow();
  });

  it('refuses multiple files under a single-file ticket', () => {
    const { tickets } = fixture();
    tickets.admittedInput(facts);
    const ticket = tickets.open({ ...facts, multiple: false });
    const files = ['a', 'b'].map((name) => ({ name, bytes: new Uint8Array([1]) }));
    expect(() => tickets.consume(ticket.id, facts, files)).toThrow();
  });

  it('expires an unused ticket without any earlier consumption attempt', () => {
    const { tickets, advance } = fixture();
    tickets.admittedInput(facts);
    const ticket = tickets.open({ ...facts, multiple: false });
    advance(60_001);
    expect(() =>
      tickets.consume(ticket.id, facts, [{ name: 'a', bytes: new Uint8Array([1]) }])
    ).toThrow();
  });
});
