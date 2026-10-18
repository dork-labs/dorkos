/**
 * An in-memory stand-in for DorkOS Cloud's two agent computer routes
 * (DOR-2940): `POST /v1/computers/{id}/link-code`, where a hub hands over the
 * code it minted, and `GET /v1/agent-computers/self/assignment`, where the
 * computer reads it, once. Every body crosses the real `@dork-labs/cloud-api`
 * schemas, so a shape the contract would refuse fails here too.
 *
 * @module services/core/agent-computer/__tests__/fake-agent-computer-cloud
 */
import {
  AgentComputerAssignmentSchema,
  AgentComputerLinkCodeRequestSchema,
  type AgentComputerAssignment,
  type AgentComputerLinkCode,
} from '@dork-labs/cloud-api';

/** What the fake answers about one computer, besides its code. */
export interface FakeAssignmentFields {
  computerId: string;
  hubOrigin: string;
  ownerAccountId: string;
  issuer: string;
  pollAfterSeconds?: number;
}

/** The fake, with the knobs a test turns. */
export interface FakeAgentComputerCloud {
  /** What the hub calls to hand over a code. */
  handToCloud: (computerId: string, body: unknown) => Promise<void>;
  /** What the computer calls to read its assignment. */
  readAssignment: () => Promise<unknown>;
  /** Read the waiting code without handing it to the computer: someone inside Cloud. */
  peekCode: () => AgentComputerLinkCode | null;
  /** Change what the next read names. */
  set: (fields: Partial<FakeAssignmentFields>) => void;
  /** Make the next read fail as a request would. */
  failNextRead: () => void;
  /** How many codes the hub has handed over. */
  readonly handed: number;
}

/**
 * Build the fake for one computer.
 *
 * @param fields - What its assignment names.
 */
export function fakeAgentComputerCloud(fields: FakeAssignmentFields): FakeAgentComputerCloud {
  let current = { ...fields };
  let code: AgentComputerLinkCode | null = null;
  let handed = 0;
  let failNext = false;
  return {
    handToCloud: async (computerId, body) => {
      const parsed = AgentComputerLinkCodeRequestSchema.parse(body);
      // Only this computer's own code reaches it; another computer's is not ours.
      if (computerId !== current.computerId) throw new Error('not_found');
      code = parsed;
      handed += 1;
    },
    readAssignment: async () => {
      if (failNext) {
        failNext = false;
        throw new Error('network down');
      }
      const answer: AgentComputerAssignment = AgentComputerAssignmentSchema.parse({
        ...current,
        linkCode: code,
      });
      // Handed out once, then deleted.
      code = null;
      return answer;
    },
    peekCode: () => code,
    set: (next) => {
      current = { ...current, ...next };
    },
    failNextRead: () => {
      failNext = true;
    },
    get handed() {
      return handed;
    },
  };
}
