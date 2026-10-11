/**
 * The in-memory half of {@link ./fake-community-adapter.js | FakeCommunityAdapter} for a
 * member's own conduct: their standing (a mute, a room's slow mode, the rules), the rules they
 * accepted, and the messages they reported. Kept apart so the adapter stays readable; the
 * adapter gates each call on its declared `conduct` and `reports` capabilities first.
 *
 * Tests arrange a state through the public fields and read reports back the same way.
 *
 * @module test-utils/fake-community-conduct
 */
import type {
  CommunityRules,
  CommunityStanding,
  ReportCommunityEntryInput,
} from '@dorkos/shared/community-adapter';

/** One report the fake received. */
export interface FakeCommunityReport {
  /** The room the reported message is in. */
  roomId: string;
  /** The reported message. */
  entryId: string;
  /** Why, and the note. */
  input: ReportCommunityEntryInput;
}

/** A member's standing, rules and reports, held in memory. */
export class FakeCommunityConduct {
  /** The rules as they stand and what the connected person accepted. Assign to arrange. */
  rules: CommunityRules = { text: null, version: 0, acceptedVersion: 0 };
  /** When the connected person's mute ends, or `null`. Assign to arrange. */
  mutedUntil: string | null = null;
  /** Each room's slow mode in seconds. Set to arrange. */
  readonly slowMode = new Map<string, number>();
  /** Every report received, in order. One per message, as a repeat is a quiet success. */
  readonly reports: FakeCommunityReport[] = [];

  /**
   * Publish new rules: a new version, which nobody has accepted yet.
   *
   * @param text - The rules, or `null` to remove them.
   */
  publishRules(text: string | null): void {
    this.rules = { text, version: this.rules.version + 1, acceptedVersion: 0 };
  }

  /**
   * The connected person's standing in one room.
   *
   * @param roomId - The room whose slow mode to read.
   */
  standing(roomId: string): CommunityStanding {
    const muted = this.mutedUntil && Date.parse(this.mutedUntil) > Date.now();
    return {
      mutedUntil: muted ? this.mutedUntil : null,
      slowModeSeconds: this.slowMode.get(roomId) ?? 0,
      rules: { ...this.rules },
    };
  }

  /**
   * Accept the rules in exactly this version; any other version is refused.
   *
   * @param version - The version the person read.
   */
  accept(version: number): CommunityRules {
    if (this.rules.text === null || version !== this.rules.version)
      throw new Error('The rules changed. Read them again first.');
    this.rules = { ...this.rules, acceptedVersion: version };
    return { ...this.rules };
  }

  /**
   * Record a report, once per message.
   *
   * @param report - The report.
   */
  report(report: FakeCommunityReport): void {
    if (this.reports.some((held) => held.entryId === report.entryId)) return;
    this.reports.push(structuredClone(report));
  }
}
