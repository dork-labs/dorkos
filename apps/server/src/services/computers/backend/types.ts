/** Exact DorkOS-owned VM identity. Callers cannot select another Lima home. */
export interface ComputerIdentity {
  id: string;
  instanceName: string;
}
/** An observed lifecycle result; uncertainty retains the disk and blocks replacement. */
export interface BackendObservation {
  phase: 'missing' | 'stopped' | 'running' | 'uncertain';
  generation: number;
}
/** Private authenticated loopback endpoints, never serialized into public computer records. */
export interface ComputerEndpoints {
  opencodeUrl: string;
  desktopUrl: string;
  opencodePassword: string;
  desktopPassword: string;
}
/** A bounded command executed as the guest agent, without a host shell. */
export interface GuestCommand {
  argv: readonly string[];
  cwd?: string;
  timeoutMs?: number;
}
/** Bounded command result. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
/** Persistent Linux computer lifecycle boundary. */
export interface ComputerBackend {
  create(identity: ComputerIdentity, generation: number): Promise<BackendObservation>;
  start(identity: ComputerIdentity, generation: number): Promise<BackendObservation>;
  status(identity: ComputerIdentity): Promise<BackendObservation>;
  stop(identity: ComputerIdentity, generation: number): Promise<BackendObservation>;
  exec(identity: ComputerIdentity, command: GuestCommand): Promise<CommandResult>;
  endpoints(identity: ComputerIdentity): Promise<ComputerEndpoints>;
}
/** Verified immutable upstream artifact. */
export interface PinnedArtifact {
  url: string;
  sha256: string;
  maxBytes: number;
}
