import { fixtureWait } from './fixture-manager-custody.js';

type Duty = {
  label: string;
  state: 'pending' | 'settled' | 'failed';
  operation: Promise<unknown> | null;
  issued: Promise<unknown> | null;
};
type Resource = {
  original: object;
  close(): Promise<unknown>;
  accepts(value: unknown): boolean;
  entered: boolean;
  label: string;
};
const retained = new Set<object>();

/** Private fixture originals; deadlines classify waiting but never discard acquisition or late resources. */
export function ownFixtureCustody() {
  const duties = new Set<Duty>(),
    resources = new Map<object, Resource>();
  const issued = new Set<Promise<unknown>>();
  const identity = { duties, resources, issued };
  retained.add(identity);
  let stopping = false,
    everHeld = false,
    reservedResources = 0;
  const releaseKnown = () => {
    if (
      stopping &&
      !everHeld &&
      [...duties].every((value) => value.state === 'settled') &&
      [...resources.values()].every((value) => value.entered)
    )
      retained.delete(identity);
  };
  const run = <T>(
    label: string,
    invoke: () => Promise<T>,
    accepts: (value: T) => boolean = () => true
  ): Promise<T> => {
    if (duties.size >= 64) throw new Error('FIXTURE_DUTY_CAPACITY');
    const duty: Duty = { label, state: 'pending', operation: null, issued: null };
    retained.add(identity);
    duties.add(duty); // Charge before the fallible producer enters.
    const original = Promise.resolve().then(() => {
      const operation = invoke();
      duty.issued = operation;
      return operation;
    });
    duty.operation = original;
    void original.then(
      (value) => {
        try {
          duty.state = accepts(value) ? 'settled' : 'failed';
        } catch {
          duty.state = 'failed';
        }
        if (duty.state === 'failed') everHeld = true;
        releaseKnown();
      },
      () => {
        duty.state = 'failed';
        everHeld = true;
      }
    );
    return original;
  };
  const enterClose = (resource: Resource) => {
    if (resource.entered) return;
    resource.entered = true;
    try {
      void run(resource.label, resource.close, resource.accepts).catch(() => {});
    } catch {
      everHeld = true;
    }
  };
  const snapshot = () => {
    const observations = [...duties].map(({ label, state }) => ({ label, state }));
    const pending =
      observations.some((value) => value.state === 'pending') ||
      [...resources.values()].some((value) => !value.entered);
    const successful = !pending && observations.every((value) => value.state === 'settled');
    return {
      observed: successful && !everHeld,
      held: everHeld || !successful,
      pending,
      observations,
    };
  };
  const adopt = <T extends object>(
    label: string,
    original: T,
    close: (value: T) => Promise<unknown>,
    accepts: (value: unknown) => boolean = () => true
  ) => {
    if (resources.has(original)) return;
    retained.add(identity);
    resources.set(original, {
      original,
      label,
      close: () => close(original),
      accepts,
      entered: false,
    });
    if (stopping) enterClose(resources.get(original)!);
  };
  return Object.freeze({
    adopt<T extends object>(
      label: string,
      original: T,
      close: (value: T) => Promise<unknown>,
      accepts: (value: unknown) => boolean = () => true
    ) {
      if (reservedResources >= 16) throw new Error('FIXTURE_RESOURCE_CAPACITY');
      reservedResources++;
      adopt(label, original, close, accepts);
    },
    acquire<T extends object>(
      label: string,
      invoke: () => Promise<T>,
      close: (value: T) => Promise<unknown>,
      milliseconds = 5000,
      acceptsClose: (value: unknown) => boolean = () => true
    ): Promise<T> {
      if (stopping || reservedResources >= 16)
        return Promise.reject(new Error('FIXTURE_ACQUISITION_REFUSED'));
      reservedResources++;
      const original = run(label, () => {
        const native = invoke();
        issued.add(native);
        return native.then((value) => {
          adopt(label + ':close', value, close, acceptsClose);
          return value;
        });
      });
      return fixtureWait(original, milliseconds, 'FIXTURE_ACQUISITION_EXPIRED');
    },
    operation<T>(label: string, invoke: () => Promise<T>, milliseconds = 5000): Promise<T> {
      return fixtureWait(run(label, invoke), milliseconds, 'FIXTURE_OPERATION_EXPIRED');
    },
    async finish(milliseconds = 5000) {
      stopping = true;
      for (const resource of resources.values()) enterClose(resource);
      const original = Promise.allSettled([...duties].map((value) => value.operation!));
      try {
        await fixtureWait(original, milliseconds, 'FIXTURE_CLEANUP_EXPIRED');
      } catch {
        everHeld = true;
      }
      // A late acquisition may have registered its close after this snapshot's original wait began.
      const result = snapshot();
      if (!result.observed) everHeld = true;
      if (result.observed) retained.delete(identity);
      return { ...snapshot(), observed: result.observed };
    },
    snapshot,
  });
}
