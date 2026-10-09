import type { BrowserLifecycleEngine } from '@dorkos/browser/server-owner';
import {
  BrowserCloseReceiptSchema,
  BrowserBindingSchema,
  BrowserReferenceSchema,
  BrowserCounterSchema,
  type BrowserBinding,
  BrowserCloseRequestSchema,
  BrowserInstanceSchema,
  BrowserProfileSchema,
  type BrowserCloseRequest,
  type BrowserInstance,
  type BrowserProfile,
} from '@dorkos/shared/browser-schemas';
import type { BrowserRegistry } from '../registry/registry.js';
import type { BrowserRegistryStore } from '../registry/store.js';

/** A uniform refusal prevents owner-qualified references becoming existence probes. */
export class BrowserApiRefusal extends Error {
  /** Closed HTTP boundary reasons; no native details cross this boundary. */
  constructor(readonly reason: 'unavailable' | 'unauthenticated' | 'inaccessible') {
    super(reason);
  }
}

/** Server-authenticated request identity, never populated from browser request data. */
export interface BrowserApiActor {
  /** Exact durable author owning this request's resources. */
  readonly owner: string;
  /** Session credential identity must remain unchanged through reentrant effects. */
  readonly credential: object;
}

/** A private vertical over the actual original-engine registry, with no native acquisition. */
export class BrowserApiService {
  /** Capture original production methods before any authorization callback can reenter. */
  constructor(
    registry: Pick<BrowserRegistry, 'instances' | 'instance' | 'stop'>,
    store: Pick<BrowserRegistryStore, 'profiles'>,
    private readonly enabled: () => boolean = () => false,
    engine?: Pick<BrowserLifecycleEngine, 'listTabs'>
  ) {
    this.readInstances = registry.instances.bind(registry);
    this.readInstance = registry.instance.bind(registry);
    this.stopInstance = registry.stop.bind(registry);
    this.readProfiles = store.profiles.bind(store);
    this.readTabs = engine?.listTabs.bind(engine);
  }

  private readonly readInstances: BrowserRegistry['instances'];
  private readonly readInstance: BrowserRegistry['instance'];
  private readonly stopInstance: BrowserRegistry['stop'];
  private readonly readProfiles: BrowserRegistryStore['profiles'];
  private readonly readTabs?: BrowserLifecycleEngine['listTabs'];

  private admitted(readActor: () => BrowserApiActor | undefined): () => string {
    if (!this.enabled()) throw new BrowserApiRefusal('unavailable');
    const actor = readActor();
    if (!actor) throw new BrowserApiRefusal('unauthenticated');
    const owner = actor.owner,
      credential = actor.credential;
    return () => {
      if (!this.enabled()) throw new BrowserApiRefusal('unavailable');
      const current = readActor();
      if (!current || current.owner !== owner || current.credential !== credential)
        throw new BrowserApiRefusal('unauthenticated');
      return owner;
    };
  }

  /** List only the authenticated owner's nonsecret profile metadata. */
  profiles(actor: () => BrowserApiActor | undefined): BrowserProfile[] {
    const check = this.admitted(actor);
    const result = this.readProfiles(check()).map((value) => BrowserProfileSchema.parse(value));
    check();
    return result;
  }

  /** Read a profile without disclosing whether a foreign profile exists. */
  profile(actor: () => BrowserApiActor | undefined, id: string): BrowserProfile {
    const result = this.profiles(actor).find((value) => value.profileId === id);
    if (!result) throw new BrowserApiRefusal('inaccessible');
    return result;
  }

  /** Registry projections query original authority; stored status alone never grants readiness. */
  instances(actor: () => BrowserApiActor | undefined): BrowserInstance[] {
    const check = this.admitted(actor);
    const result = this.readInstances(check()).map((value) => BrowserInstanceSchema.parse(value));
    check();
    return result;
  }

  /** Read only one exact owner-qualified original generation. */
  instance(
    actor: () => BrowserApiActor | undefined,
    id: string,
    generation: number
  ): BrowserInstance {
    const check = this.admitted(actor);
    const result = BrowserInstanceSchema.parse(this.readInstance(check(), id, generation));
    check();
    return result;
  }

  /** Read exact original current tab bindings for this owner; these DTOs grant no viewer or input permission. */
  bindings(
    actor: () => BrowserApiActor | undefined,
    browserIdValue: string,
    generationValue: number
  ): readonly BrowserBinding[] {
    const id = BrowserReferenceSchema.parse(browserIdValue);
    const generation = BrowserCounterSchema.parse(generationValue);
    const check = this.admitted(actor);
    const original = this.readTabs;
    if (!original) throw new BrowserApiRefusal('unavailable');
    const running = () => {
      const instance = BrowserInstanceSchema.parse(this.readInstance(check(), id, generation));
      if (
        instance.browserId !== id ||
        instance.browserGeneration !== generation ||
        instance.status !== 'running'
      )
        throw new BrowserApiRefusal('inaccessible');
    };
    running();
    // Capture immutable canonical metadata only after the genuine registry's original custody read.
    const values = original(id, generation).map((value) => {
      const binding = BrowserBindingSchema.parse(value);
      if (binding.browserId !== id || binding.browserGeneration !== generation)
        throw new BrowserApiRefusal('inaccessible');
      return Object.freeze(binding);
    });
    // A final original registry read can revoke custody or replace actor/config during observation.
    running();
    const current = original(id, generation).map((value) => BrowserBindingSchema.parse(value));
    if (JSON.stringify(current) !== JSON.stringify(values))
      throw new BrowserApiRefusal('inaccessible');
    // The second original tab read is fallible/reentrant too; observe genuine custody after it.
    running();
    check();
    return Object.freeze(values);
  }

  /** Retire the exact original; a returned stop invocation is never a cleanup observation. */
  close(actor: () => BrowserApiActor | undefined, request: BrowserCloseRequest) {
    request = BrowserCloseRequestSchema.parse(request);
    const check = this.admitted(actor);
    // Refuse unknown/foreign generations before entering any retirement effect.
    this.readInstance(check(), request.browserId, request.browserGeneration);
    this.stopInstance(check(), request.browserId, request.browserGeneration);
    const value = this.readInstance(check(), request.browserId, request.browserGeneration);
    check();
    return BrowserCloseReceiptSchema.parse(
      value.status === 'stopped'
        ? { ...request, cleanup: 'observed' }
        : { ...request, cleanup: 'unverified', reason: 'observationUnavailable' }
    );
  }
}
