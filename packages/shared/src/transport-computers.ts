import type {
  ComputerStatus,
  ComputerSession,
  ComputerFrame,
  ComputerInput,
  ComputerControlLease,
} from './computer-schemas.js';

/** The one experimental local computer, without private guest endpoints or credentials. */
export interface ComputerTransport {
  /** Read observed lifecycle state without starting the computer. */
  getComputer(): Promise<ComputerStatus>;
  /** Begin idempotent setup; progress is read through getComputer. */
  createComputer(): Promise<ComputerStatus>;
  /** Start or reconnect the retained computer. */
  startComputer(): Promise<ComputerStatus>;
  /** Stop its exact owned VM, retaining the persistent disk. */
  stopComputer(): Promise<ComputerStatus>;
  /** Open the actual vendor program in the guest terminal. */
  signInComputer(): Promise<ComputerStatus>;
  /** Create a normal, computer-bound chat. */
  createComputerSession(): Promise<ComputerSession>;
  /** Take exclusive control of the current guest display. */
  acquireComputerControl(): Promise<ComputerControlLease>;
  /** Return control and release held input. */
  releaseComputerControl(leaseId: string): Promise<void>;
  /** Send one leased, generation-bound input action. */
  sendComputerInput(input: ComputerInput): Promise<void>;
  /** Read the actual current guest framebuffer. */
  getComputerFrame(): Promise<ComputerFrame>;
}
