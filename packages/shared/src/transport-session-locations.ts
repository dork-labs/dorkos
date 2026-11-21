/** An existing server-held source for a person's new chat. */
export type SessionAllocationSource =
  { kind: 'location'; launchRef: string } | { kind: 'registered-agent'; agentId: string };

/** The id acknowledged by the server before the first settings write or send. */
export interface SessionAllocationReceipt {
  sessionId: string;
  launchRef?: string;
}

/** Resolve private chat sources and acknowledge a new chat without starting it. */
export interface SessionLocationTransport {
  /** Reserve a durable, caller-scoped opaque reference to a launch directory. */
  createSessionLocation(cwd: string): Promise<{ id: string }>;
  /** Resolve a launch reference without exposing its private directory. */
  getSessionLocation(id: string): Promise<{ cwd: string }>;
  /** Allocate one fresh chat using the source already known to the server. */
  allocateSession(source: SessionAllocationSource): Promise<SessionAllocationReceipt>;
}
