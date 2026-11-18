/**
 * `ctx.personRecord`: DorkOS's own record of what this extension did for a
 * signed-in person (DOR-4301).
 *
 * An extension's data file is a file: anything that can write it can write
 * "a person said this". This record is kept by DorkOS, outside the
 * extension's folder, and takes a row only while a request from a signed-in
 * person to this extension is running (behind `ctx.requirePerson`, or in a
 * fetch handler whose `caller.person.ok` is true). So a check that reads it
 * answers "was this recorded via a signed-in session", which the data file
 * cannot.
 *
 * @module extension-api/person-record
 */

/** What DorkOS recorded: the content's hash and when it was first recorded. */
export interface PersonRecordReceipt {
  /** Lowercase hex SHA-256 of the content, as DorkOS computed it. */
  readonly hash: string;
  /** When it was first recorded (ISO 8601). */
  readonly at: string;
}

/** `ctx.personRecord`. Probe with `ctx.personRecord !== undefined`. */
export interface PersonRecordApi {
  /**
   * Record `content` (1 to 16,000 characters) as done for the signed-in person
   * whose request is running. Rejects outside such a request, including in an
   * agent tool's handler and after the response ended, and past 16 records in
   * one request. Recording the same content again keeps the first time. Record
   * what the person's action can be told by, such as an item id, a comment id
   * and its text, in one string your `verify` call rebuilds the same way.
   * An isolated extension (`serverCapabilities.runtime: "subprocess"`) can't
   * record yet: there it always rejects, and `verify` still works.
   */
  record(content: string): Promise<PersonRecordReceipt>;
  /**
   * The record of `content`, or `null` when this extension never recorded it
   * during a signed-in person's request. Works anywhere, an agent tool included.
   */
  verify(content: string): Promise<PersonRecordReceipt | null>;
}
