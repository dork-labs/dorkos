/**
 * The load gate's queue: one first-come line of heavy jobs per machine, shared
 * by every DorkOS process this user runs (DOR-4209).
 *
 * ## The folder
 *
 * Everything lives in one fixed folder, `/tmp/dorkos-load-gate-<uid>` ({@link
 * defaultLoadGateDir}), so two DorkOS servers, a dev server and the dogfood app
 * on one Mac all wait in the same line. Plain synchronous file operations,
 * chosen because each step's atomicity is then obvious:
 *
 * - `seq-<n>`: a claimed number. A new ticket takes the next free one with an
 *   exclusive create (`wx`), which only one process can win, so numbers are
 *   unique and rise in the order tickets were made. Old claims are tidied once
 *   they are a minute old; the newest is never removed, so numbering never goes
 *   back.
 * - `ticket-<n>-<id>.json`: a waiting job, written to a temp file and renamed
 *   into place so no reader sees half of it.
 * - `urgent-<id>` and `let-through-<id>`: a person's marks on a waiting ticket.
 *   Separate files rather than a rewrite, so a mark that lands just as the
 *   ticket leaves can never bring the ticket back.
 * - `slot-<k>.json`: a running job holding slot `k`. Taken with a hard link,
 *   which fails if the slot is already taken and never leaves a half-written
 *   marker, so the slot count holds across processes.
 * - `through-<id>.json`: a running job let past the limits (by a person, or by
 *   the hard cap).
 *
 * Every agent's shell runs as this same user and can read the folder, so files
 * hold nothing that names an agent, a chat or a command: ids, numbers, the
 * owner's pid and start time, and the program label. Who a job is for stays in
 * the server's memory ({@link createLoadGate}).
 *
 * ## Order
 *
 * Urgent tickets first, then by number. Only the first `slots - running` tickets
 * may start, so a later ticket never overtakes an earlier one for a free slot.
 * A let-through ticket skips both the load check and the slot count, because a
 * person asked for exactly that job to run now; while it runs it still counts as
 * running for everyone behind it.
 *
 * ## Owners that went away, and owners that went quiet
 *
 * Every ticket and marker records its owner's pid and start time, and its file
 * time is a heartbeat its owner refreshes on every poll and, for a running job,
 * while it runs. Each listing removes a record whose owner is gone, whose pid
 * now belongs to a newer process ({@link holderIsLive}), or that has gone quiet
 * ({@link LeaseWatch}): a live process that forgot to release cannot hold the
 * machine until the hard cap. This queue never calls its own records quiet while
 * it still vouches for them; a running job's caller stops vouching with
 * {@link TicketQueue.disown}, after which its own heartbeat is all that keeps it.
 *
 * @module services/core/load-gate/ticket-queue
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { holderIsLive, selfHolder, systemHolderProbe } from './holder-identity.js';
import type { Holder, HolderProbe } from './holder-identity.js';
import { JOB_LABEL } from './job-label.js';
import { defaultLoadGateDir, prepareDir } from './queue-folder.js';
import { LeaseWatch, mtimeOf, takeAway, type JudgedRecord } from './reclaim.js';

/**
 * How long another process's ticket or slot may keep one file time before it
 * counts as forgotten. Six missed 5-second polls: long enough that a stalled
 * event loop or a slow disk does not cost a live job its place, short enough
 * that a slot nobody released frees within a minute.
 */
export const DEFAULT_LEASE_MS = 30_000;
/** A ticket id: random hex, so a person-supplied id can never name another file. */
const ID_PATTERN = /^[0-9a-f]{16}$/;
const ID_BYTES = 8;
const SEQ_DIGITS = 12;
const SEQ_CLAIM = /^seq-(\d{12})$/;
const TICKET_FILE = /^ticket-(\d{12})-([0-9a-f]{16})\.json$/;
const MARKER_FILE = /^(slot-\d+|through-[0-9a-f]{16})\.json$/;
const FLAG_FILE = /^(urgent|let-through)-([0-9a-f]{16})$/;
const LEFTOVER_FILE = /^\.(tmp|tomb)-/;
const MAX_SEQ_ATTEMPTS = 1_000;
/** How old a number claim or a stray temp file is before it is tidied. */
const LEFTOVER_AGE_MS = 60_000;

/** How soon a ticket's job should run. */
export type TicketPriority = 'urgent' | 'normal';

const TicketSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  seq: z.number().int().nonnegative(),
  pid: z.number().int().positive(),
  startedAt: z.number().int(),
  createdAt: z.number(),
  priority: z.enum(['urgent', 'normal']),
  job: z.string().regex(JOB_LABEL),
});

const MarkerSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  pid: z.number().int().positive(),
  startedAt: z.number().int(),
  acquiredAt: z.number(),
});

/** A running job's marker, with the file it sits in. */
type RunningMarker = z.infer<typeof MarkerSchema> & { name: string };

/** One waiting heavy job. `letThrough` is set once a person let it past the limits. */
export type Ticket = z.infer<typeof TicketSchema> & { letThrough?: boolean };

/** What a caller says about the job it is queueing. Nothing here names an agent or a chat. */
export interface TicketInfo {
  /** The program label the classifier gave, such as `pnpm` or `tsc`. Never command text. */
  job: string;
  /** Defaults to `normal`. */
  priority?: TicketPriority;
}

/** The limits one attempt to start is judged against. */
export interface AcquireLimits {
  /** How many heavy jobs may run at once. */
  slots: number;
  /** The machine's five-minute load average now. */
  load: number;
  /** The load at or above which jobs wait. */
  maxLoad: number;
}

/**
 * What one attempt to start came to: a free slot, a let-through past the
 * limits, keep waiting, or the ticket is no longer in line ({@link
 * TicketQueue.rejoin} puts it back).
 */
export type AcquireResult = 'slot' | 'let-through' | 'wait' | 'lost';

/** Where the queue lives and how it reads the world. */
export interface TicketQueueOptions {
  /** The shared folder. Defaults to {@link defaultLoadGateDir}. */
  dir?: string;
  /** Process facts, for telling live owners from gone ones. */
  probe?: HolderProbe;
  /** The wall clock tickets, markers and heartbeats are stamped with. */
  now?: () => number;
  /** A monotonic clock the lease is timed on. Defaults to `performance.now()`. */
  monoNow?: () => number;
  /** How long another process's record may stay unchanged. Defaults to {@link DEFAULT_LEASE_MS}. */
  leaseMs?: number;
  /**
   * Who this queue writes tickets as.
   *
   * @internal For tests that need a ticket owned by some other process.
   */
  self?: Holder;
}

/** Whether a file-system error carries this code. */
function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

const pad = (seq: number): string => String(seq).padStart(SEQ_DIGITS, '0');
const ticketName = (ticket: Pick<Ticket, 'seq' | 'id'>): string =>
  `ticket-${pad(ticket.seq)}-${ticket.id}.json`;
const throughName = (id: string): string => `through-${id}.json`;

/** Urgent first, then first come. */
function byQueueOrder(a: Ticket, b: Ticket): number {
  if (a.priority !== b.priority) return a.priority === 'urgent' ? -1 : 1;
  return a.seq - b.seq;
}

/** The machine-wide queue of heavy jobs. See the module docs for the folder layout. */
export class TicketQueue {
  /** The shared folder this queue reads and writes. */
  readonly dir: string;
  private readonly probe: HolderProbe;
  private readonly now: () => number;
  private readonly lease: LeaseWatch;
  private readonly self: Holder;
  /** The marker file each of this queue's running jobs holds, by ticket id. */
  private readonly holding = new Map<string, string>();
  /** The files this queue vouches for: its waiting tickets and the slots it holds. */
  private readonly mine = new Set<string>();

  /**
   * Open the queue, creating its folder if needed.
   *
   * @param options - Where it lives and how it reads the world.
   */
  constructor(options: TicketQueueOptions = {}) {
    this.dir = options.dir ?? defaultLoadGateDir();
    this.probe = options.probe ?? systemHolderProbe;
    this.now = options.now ?? Date.now;
    this.lease = new LeaseWatch(
      options.leaseMs ?? DEFAULT_LEASE_MS,
      options.monoNow ?? (() => performance.now())
    );
    prepareDir(this.dir);
    this.self = options.self ?? selfHolder(this.probe);
  }

  /**
   * Join the back of the line (or the back of the urgent part of it).
   *
   * @param info - The job's program label and priority.
   */
  enqueue(info: TicketInfo): Ticket {
    if (!JOB_LABEL.test(info.job)) {
      throw new TypeError('A ticket names its job by program only, such as "pnpm" or "tsc".');
    }
    this.sweepLeftovers();
    const ticket: Ticket = {
      id: randomBytes(ID_BYTES).toString('hex'),
      seq: this.claimSeq(),
      pid: this.self.pid,
      startedAt: this.self.startedAt,
      createdAt: this.now(),
      priority: info.priority ?? 'normal',
      job: info.job,
    };
    this.writeTicket(ticket);
    return ticket;
  }

  /**
   * Put a ticket that went missing back in line at its own number, so it keeps
   * its place. Used when its file was removed underneath its live owner.
   *
   * @param ticket - The caller's own ticket.
   */
  rejoin(ticket: Ticket): void {
    // Parsed, so only the fields a ticket file holds are written back.
    this.writeTicket(TicketSchema.parse(ticket));
  }

  /**
   * Refresh the heartbeat of this ticket, or of the slot it holds. Never throws.
   *
   * @param ticket - The caller's own ticket.
   * @returns `false` when the slot it held is no longer its own (taken back while
   *   this process was stalled, and perhaps someone else's now), so nothing was
   *   refreshed for it; `true` otherwise.
   */
  beat(ticket: Pick<Ticket, 'seq' | 'id'>): boolean {
    const at = new Date(this.now());
    this.touch(ticketName(ticket), at);
    const marker = this.holding.get(ticket.id);
    if (marker === undefined) return true;
    // Checked first, so another job's marker under a reused slot name is never refreshed.
    // What is left is the instant between this read and the refresh.
    if (this.read(this.file(marker), MarkerSchema)?.id !== ticket.id) {
      this.holding.delete(ticket.id);
      this.mine.delete(marker);
      return false;
    }
    return this.touch(marker, at);
  }

  /**
   * Stop vouching for this ticket's slot: from now on only its heartbeat keeps
   * it, here as everywhere else. A running job's caller does this once it has
   * stopped beating on its own.
   *
   * @param ticket - The caller's own ticket.
   */
  disown(ticket: Pick<Ticket, 'seq' | 'id'>): void {
    this.mine.delete(ticketName(ticket));
    const marker = this.holding.get(ticket.id);
    if (marker !== undefined) this.mine.delete(marker);
  }

  /** Every waiting ticket whose owner is live and beating, in queue order. Removes the rest. */
  list(): Ticket[] {
    const names = this.names();
    const flags = new Set(names.filter((name) => FLAG_FILE.test(name)));
    const tickets: Ticket[] = [];
    const ids = new Set<string>();
    for (const name of names) {
      if (!TICKET_FILE.test(name)) continue;
      const ticket = this.read(this.file(name), TicketSchema);
      // Ticket names are never reused, so removing this one cannot remove anyone else's.
      // An unreadable one is left while it might be someone's, removed once it is quiet.
      if (ticket === null ? this.quiet(name) : !this.isCurrent(name, ticket)) {
        this.remove(name);
        continue;
      }
      if (ticket === null) continue;
      ids.add(ticket.id);
      const urgent = flags.has(`urgent-${ticket.id}`);
      const letThrough = flags.has(`let-through-${ticket.id}`);
      tickets.push({
        ...ticket,
        priority: urgent ? 'urgent' : ticket.priority,
        ...(letThrough ? { letThrough: true } : {}),
      });
    }
    // A mark whose ticket has gone (it started, or its owner left) marks nothing.
    for (const flag of flags) if (!ids.has(FLAG_FILE.exec(flag)![2]!)) this.remove(flag);
    return tickets.sort(byQueueOrder);
  }

  /**
   * A ticket's place in line, counting from 1, or 0 when it is not in line.
   *
   * @param ticket - The ticket to find.
   */
  position(ticket: Pick<Ticket, 'id'>): number {
    return this.list().findIndex((waiting) => waiting.id === ticket.id) + 1;
  }

  /** How many jobs are running now, let-through ones included. */
  runningCount(): number {
    return this.running().length;
  }

  /**
   * Start the job if its turn has come: within the first free slots, below the
   * load limit, with a slot to take. A let-through ticket starts regardless.
   *
   * @param ticket - The caller's own ticket.
   * @param limits - The slot count and load to judge against.
   */
  tryAcquire(ticket: Ticket, limits: AcquireLimits): AcquireResult {
    const waiting = this.list();
    const index = waiting.findIndex((candidate) => candidate.id === ticket.id);
    if (index === -1) return 'lost';
    if (waiting[index]!.letThrough) {
      this.forceAcquire(ticket);
      return 'let-through';
    }
    if (limits.load >= limits.maxLoad) return 'wait';
    const running = this.running();
    if (index >= limits.slots - running.length) return 'wait';
    const taken = new Set(running.map((marker) => marker.name));
    for (let slot = 0; slot < limits.slots; slot += 1) {
      const name = `slot-${slot}.json`;
      if (taken.has(name) || !this.claim(name, this.markerFor(ticket))) continue;
      this.hold(ticket, name);
      return 'slot';
    }
    return 'wait';
  }

  /**
   * Start the job past every limit: a person let it through, or it reached the
   * hard cap. It still counts as running for the tickets behind it.
   *
   * @param ticket - The caller's own ticket.
   */
  forceAcquire(ticket: Ticket): void {
    this.claim(throughName(ticket.id), this.markerFor(ticket));
    this.hold(ticket, throughName(ticket.id));
  }

  /**
   * Leave the line, or give back the slot, for this ticket. Safe to call twice.
   *
   * @param ticket - The caller's own ticket.
   */
  release(ticket: Ticket): void {
    this.leaveLine(ticket);
    const held = this.holding.get(ticket.id);
    if (held !== undefined) this.mine.delete(held);
    this.holding.delete(ticket.id);
    this.remove(throughName(ticket.id));
    const ours = (file: string): boolean => this.read(file, MarkerSchema)?.id === ticket.id;
    for (const name of this.names()) {
      if (name.startsWith('slot-') && ours(this.file(name))) takeAway(this.dir, name, ours);
    }
  }

  /**
   * Let a waiting job past the load and slot limits (a person's choice).
   *
   * @param id - The ticket's id.
   * @returns Whether a waiting ticket with that id was found.
   */
  markLetThrough(id: string): boolean {
    return this.mark('let-through', id);
  }

  /**
   * Move a waiting job ahead of every normal one (a person's choice).
   *
   * @param id - The ticket's id.
   * @returns Whether a waiting ticket with that id was found.
   */
  markUrgent(id: string): boolean {
    return this.mark('urgent', id);
  }

  private mark(kind: 'urgent' | 'let-through', id: string): boolean {
    if (!ID_PATTERN.test(id) || !this.list().some((ticket) => ticket.id === id)) return false;
    fs.writeFileSync(this.file(`${kind}-${id}`), '');
    return true;
  }

  private hold(ticket: Ticket, marker: string): void {
    this.holding.set(ticket.id, marker);
    this.mine.add(marker);
    this.leaveLine(ticket);
  }

  /** Running jobs whose owner is live and beating. Takes away the rest. */
  private running(): RunningMarker[] {
    const markers: RunningMarker[] = [];
    for (const name of this.names()) {
      if (!MARKER_FILE.test(name)) continue;
      const file = this.file(name);
      const marker = this.read(file, MarkerSchema);
      const stale = marker === null ? this.quiet(name) : !this.isCurrent(name, marker);
      if (!stale) {
        // An unreadable marker that has not gone quiet still holds its slot; it may be someone's.
        if (marker !== null) markers.push({ ...marker, name });
        continue;
      }
      const mtimeMs = mtimeOf(file);
      if (mtimeMs === null) continue;
      const judged: JudgedRecord = { id: marker?.id ?? null, mtimeMs };
      // Removed only if, once moved aside, it is still exactly the record judged.
      takeAway(this.dir, name, (moved) => {
        const movedId = this.read(moved, MarkerSchema)?.id ?? null;
        return movedId === judged.id && mtimeOf(moved) === judged.mtimeMs;
      });
    }
    return markers;
  }

  /** Whether a record's owner is live and its heartbeat has not gone quiet. */
  private isCurrent(name: string, holder: Holder): boolean {
    return holderIsLive(holder, this.probe, this.self) && !this.quiet(name);
  }

  /**
   * Whether a record has gone quiet: never one this queue vouches for; for any
   * other, its file time unchanged for a full lease as this queue watched it.
   * A record that is already gone counts as quiet, since removing it does nothing.
   */
  private quiet(name: string): boolean {
    if (this.mine.has(name)) return false;
    const mtimeMs = mtimeOf(this.file(name));
    return mtimeMs === null || this.lease.quiet(name, mtimeMs);
  }

  private touch(name: string, at: Date): boolean {
    try {
      fs.utimesSync(this.file(name), at, at);
      return true;
    } catch {
      // Gone, or the folder is gone: the next check says so.
      return false;
    }
  }

  private markerFor(ticket: Ticket): string {
    return JSON.stringify({
      id: ticket.id,
      pid: ticket.pid,
      startedAt: ticket.startedAt,
      acquiredAt: this.now(),
    });
  }

  private writeTicket(ticket: Ticket): void {
    const temp = this.writeTemp(JSON.stringify(ticket));
    fs.renameSync(temp, this.file(ticketName(ticket)));
    this.mine.add(ticketName(ticket));
  }

  private leaveLine(ticket: Pick<Ticket, 'seq' | 'id'>): void {
    this.mine.delete(ticketName(ticket));
    this.remove(ticketName(ticket));
    this.remove(`urgent-${ticket.id}`);
    this.remove(`let-through-${ticket.id}`);
  }

  /** Take the next number. Only one process can create a given `seq-<n>`. */
  private claimSeq(): number {
    const used = this.names().flatMap((name) => {
      const match = SEQ_CLAIM.exec(name) ?? TICKET_FILE.exec(name);
      return match ? [Number(match[1])] : [];
    });
    let seq = Math.max(0, ...used) + 1;
    for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt += 1, seq += 1) {
      try {
        fs.writeFileSync(this.file(`seq-${pad(seq)}`), '', { flag: 'wx' });
        return seq;
      } catch (error) {
        if (!isCode(error, 'EEXIST')) throw error;
      }
    }
    throw new Error('The load gate could not number a new ticket.');
  }

  /**
   * Tidy number claims below the newest, and stray temp and set-aside files, once
   * each is a minute old: long past any step in flight, and the newest claim stays.
   */
  private sweepLeftovers(): void {
    const entries = this.rawNames();
    const claims = entries.filter((name) => SEQ_CLAIM.test(name)).sort();
    const stale = [...claims.slice(0, -1), ...entries.filter((name) => LEFTOVER_FILE.test(name))];
    for (const name of stale) {
      const mtimeMs = mtimeOf(this.file(name));
      if (mtimeMs !== null && Date.now() - mtimeMs > LEFTOVER_AGE_MS) this.remove(name);
    }
  }

  /** Create `name` holding `content`, only if nothing has that name yet. */
  private claim(name: string, content: string): boolean {
    const temp = this.writeTemp(content);
    try {
      fs.linkSync(temp, this.file(name));
      return true;
    } catch (error) {
      if (isCode(error, 'EEXIST')) return false;
      throw error;
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  /** A new temp file holding `content`, its heartbeat stamped now. */
  private writeTemp(content: string): string {
    const temp = this.file(`.tmp-${randomBytes(ID_BYTES).toString('hex')}`);
    fs.writeFileSync(temp, content, { flag: 'wx' });
    const at = new Date(this.now());
    fs.utimesSync(temp, at, at);
    return temp;
  }

  private read<T>(file: string, schema: z.ZodType<T>): T | null {
    try {
      const parsed = schema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private remove(name: string): void {
    fs.rmSync(this.file(name), { force: true });
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  /** Every entry, dot files included. A folder the system temp cleaner removed is made again. */
  private rawNames(): string[] {
    try {
      return fs.readdirSync(this.dir);
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
      prepareDir(this.dir);
      return [];
    }
  }

  private names(): string[] {
    const names = this.rawNames().filter((name) => !name.startsWith('.'));
    this.lease.retain(new Set(names));
    return names;
  }
}
