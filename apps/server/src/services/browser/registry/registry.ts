import type {
  PrivateBrowserBirthOwner,
  PrivateBrowserRetirementReceiver,
} from '@dorkos/browser/server-owner';
import {
  BrowserAttachmentSchema,
  type BrowserAttachment,
  type BrowserInstance,
} from '@dorkos/shared/browser-schemas';
import type { BrowserInstanceRow } from '@dorkos/db';
import { BrowserRegistryError } from './errors.js';
import { BrowserRegistryStore, type RegistryMode } from './store.js';

type Original = {
  readonly receiver: PrivateBrowserRetirementReceiver;
  readonly row: BrowserInstanceRow;
  readonly ordinary: () => boolean;
  readonly current: () => boolean;
  readonly retire: () => Promise<unknown>;
  status: BrowserInstanceRow['status'];
  fenced: boolean;
};

/** Private original-engine authority; durable associations are never permission checks. */
export class BrowserRegistry {
  private readonly originals = new Map<string, Original>();
  private readonly faulted = new Set<string>();

  /** Reconcile unknown previous identities before any new birth can acquire a profile. */
  constructor(
    private readonly store: BrowserRegistryStore,
    private readonly authorizeAttachment: (owner: string, target: BrowserAttachment) => boolean
  ) {
    // Restart never restores callbacks, grants, tabs, input, or a database-running claim.
    // Without the original process observation every previous live identity is uncertain.
    for (const row of store.rows())
      if (row.status !== 'stopped') store.transition(row, 'uncertain');
  }

  /** Make an engine-constructor callback owner with immutable authenticated owner/mode. */
  birthOwner(
    owner: string,
    mode: RegistryMode,
    network?: PrivateBrowserBirthOwner['network']
  ): PrivateBrowserBirthOwner {
    const acquisition: RegistryMode =
      mode.mode === 'persistent'
        ? Object.freeze({ mode: 'persistent', profileId: mode.profileId })
        : Object.freeze({ mode: 'ephemeral' });
    return Object.freeze({
      ...(network ? { network } : {}),
      registerBirth: (receiver: PrivateBrowserRetirementReceiver) =>
        this.register(owner, acquisition, receiver),
      refuseBirth: (receiver: PrivateBrowserRetirementReceiver) => {
        const original = this.originals.get(receiver.browserId);
        if (!original || original.receiver !== receiver) return;
        this.write(original, 'uncertain');
        this.fence(original);
      },
    });
  }

  private register(
    owner: string,
    mode: RegistryMode,
    receiver: PrivateBrowserRetirementReceiver
  ): void {
    const id = receiver.browserId,
      generation = receiver.browserGeneration;
    if (this.originals.has(id)) throw new BrowserRegistryError('staleBinding');
    const acquisition = receiver.acquisition;
    if (
      acquisition.mode !== mode.mode ||
      (mode.mode === 'persistent' &&
        (acquisition.mode !== 'persistent' || acquisition.profileId !== mode.profileId))
    )
      throw new BrowserRegistryError('inaccessible');
    // Bind all original methods before native work; later replacement of a facade cannot grant access.
    const ordinary = receiver.isOrdinary.bind(receiver),
      current = receiver.isAuthorityCurrent.bind(receiver);
    const retire = receiver.authorityRevoked.bind(receiver),
      persistenceFailure = receiver.persistenceFailure.bind(receiver);
    const observation = receiver.observation;
    try {
      this.store.birth(owner, mode, id, generation);
    } catch (error) {
      try {
        void persistenceFailure().catch(() => {});
      } catch {
        /* Preserve the database refusal. */
      }
      throw error;
    }
    const original: Original = {
      receiver,
      row: this.store.instance(owner, id, generation),
      ordinary,
      current,
      retire,
      status: 'opening',
      fenced: false,
    };
    this.originals.set(id, original);
    // Keep the exact engine observation owned even after caller detach. No timers fabricate cleanup.
    void observation
      .then(
        (result) => {
          const closed =
            result.terminal.cleanup === 'observed' &&
            result.cleanup.state === 'settled' &&
            result.cleanup.coverage === 'closed' &&
            !result.cleanup.pending &&
            result.uncertainty.length === 0;
          this.write(original, closed ? 'stopped' : 'uncertain');
        },
        () => this.write(original, 'uncertain')
      )
      .catch(() => {
        this.faulted.add(id);
        this.fence(original);
      });
  }

  private write(original: Original, status: BrowserInstanceRow['status']): void {
    if (this.originals.get(original.row.browserId) !== original || original.status === 'stopped')
      return;
    if (status === 'running' && (original.fenced || !original.ordinary() || !original.current()))
      status = 'uncertain';
    try {
      this.store.transition(original.row, status);
      original.status = status;
      if (status === 'uncertain') this.fence(original);
    } catch (error) {
      this.faulted.add(original.row.browserId);
      this.fence(original);
      throw error;
    }
  }

  private fence(original: Original): void {
    if (original.fenced) return;
    original.fenced = true;
    // Start exact owned retirement immediately. Its genuine observation alone releases the profile.
    try {
      void original.retire().catch(() => {
        this.faulted.add(original.row.browserId);
      });
    } catch {
      this.faulted.add(original.row.browserId);
    }
  }

  private refresh(
    row: BrowserInstanceRow,
    onOriginalDenial?: (value: BrowserRegistryError) => void
  ): BrowserInstanceRow {
    const original = this.originals.get(row.browserId);
    if (this.faulted.has(row.browserId)) throw new BrowserRegistryError('profileUncertain');
    if (!original) {
      if (row.status !== 'stopped') this.store.transition(row, 'uncertain');
      return this.store.instance(
        row.ownerAuthorId,
        row.browserId,
        row.browserGeneration,
        onOriginalDenial
      );
    }
    if (
      original &&
      original.row.ownerAuthorId === row.ownerAuthorId &&
      original.row.browserGeneration === row.browserGeneration &&
      original.status !== 'stopped'
    ) {
      if (!original.fenced) {
        let ready = false;
        try {
          ready = original.ordinary() && original.current();
        } catch {
          /* Unknown observation refuses. */
        }
        if (ready) this.write(original, 'running');
        else if (original.status === 'opening') this.write(original, 'opening');
        else if (original.status === 'running') {
          this.write(original, 'uncertain');
          this.fence(original);
        }
      }
    }
    return this.store.instance(
      row.ownerAuthorId,
      row.browserId,
      row.browserGeneration,
      onOriginalDenial
    );
  }

  private publicRow(
    owner: string,
    browserId: string,
    generation: number,
    onOriginalDenial?: (value: BrowserRegistryError) => void
  ): BrowserInstanceRow {
    const row = this.store.instance(owner, browserId, generation, onOriginalDenial);
    if (row.profileId && this.store.isProfileImport(owner, row.profileId)) {
      const refusal = new BrowserRegistryError('inaccessible');
      onOriginalDenial?.(refusal);
      throw refusal;
    }
    return row;
  }

  /** Return live metadata only after querying the original engine, never database status alone. */
  instance(
    owner: string,
    browserId: string,
    generation: number,
    onOriginalDenial?: (value: BrowserRegistryError) => void
  ): BrowserInstance {
    return this.store.project(
      this.refresh(this.publicRow(owner, browserId, generation, onOriginalDenial), onOriginalDenial)
    );
  }

  /** List only authenticated owner's metadata, refreshing actual owned engine authority. */
  instances(owner: string): BrowserInstance[] {
    return this.store
      .rows()
      .filter(
        (row) =>
          row.ownerAuthorId === owner &&
          !(row.profileId && this.store.isProfileImport(owner, row.profileId))
      )
      .map((row) => this.store.project(this.refresh(row)));
  }

  /** Associate only an independently authorized target with a genuinely current owned browser. */
  attach(owner: string, browserId: string, generation: number, target: BrowserAttachment): string {
    const attachment = Object.freeze(BrowserAttachmentSchema.parse(target));
    const row = this.refresh(this.publicRow(owner, browserId, generation));
    if (row.status !== 'running') throw new BrowserRegistryError('stopped');
    if (!this.authorizeAttachment(owner, attachment))
      throw new BrowserRegistryError('inaccessible');
    // Authorization callbacks can reenter and retire the original; reobserve before the write.
    const current = this.refresh(row);
    if (current.status !== 'running') throw new BrowserRegistryError('stopped');
    return this.store.attach(current, attachment);
  }

  /** Remove a metadata association only. Detach never retires a browser. */
  detach(owner: string, attachmentId: string): void {
    this.store.detach(owner, attachmentId);
  }

  /** Explicitly retire this exact original generation; unknown restart records cannot be rebound. */
  stop(owner: string, browserId: string, generation: number): void {
    const row = this.store.instance(owner, browserId, generation);
    if (row.status === 'stopped') return;
    const original = this.originals.get(browserId);
    if (
      !original ||
      original.row.ownerAuthorId !== owner ||
      original.row.browserGeneration !== generation
    )
      throw new BrowserRegistryError('profileUncertain');
    this.fence(original);
    this.write(original, 'stopping');
  }
}
