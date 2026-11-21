import type { Duplex } from 'node:stream';
import type { classifyPosixJoin } from './join-fact.mjs';

export function bindWorkerReports(
  control: Duplex,
  connection: { endpointId: string; token: string },
  callbacks: {
    receive(kind: string, fact: unknown): void | Promise<void>;
    joined(fact: ReturnType<typeof classifyPosixJoin>): void;
    lost(): void;
    retainOutput(): boolean;
  }
): void;
