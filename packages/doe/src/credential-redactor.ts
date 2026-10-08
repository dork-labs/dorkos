/** Redact explicit credentials without changing unrelated JSON fields. */
export class CredentialRedactor {
  private readonly forms = new Set<string>();
  private readonly pending = new Map<string, string>();
  add(key: string): void {
    for (const form of [key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key)])
      if (form) this.forms.add(form);
  }
  text(text: string): string {
    for (const form of this.forms) text = text.split(form).join('[redacted credential]');
    return text;
  }
  json<T>(value: T): T {
    const walk = (value: unknown): unknown => {
      if (typeof value === 'string') return this.text(value);
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') {
        const entries = Object.entries(value).map(([key, item]) => [this.text(key), walk(item)]);
        if (new Set(entries.map(([key]) => key)).size !== entries.length)
          throw new Error('Credential redaction would discard an opaque field');
        return Object.fromEntries(entries);
      }
      return value;
    };
    return walk(JSON.parse(JSON.stringify(value))) as T;
  }
  /** Hold only a possible credential prefix, so split deltas cannot expose the full key. */
  delta(id: string, value: string, flush = false): string {
    const text = this.text((this.pending.get(id) ?? '') + value);
    let held = 0;
    if (!flush)
      for (const form of this.forms)
        for (let n = 1; n < form.length && n <= text.length; n++)
          if (text.endsWith(form.slice(0, n))) held = Math.max(held, n);
    this.pending.set(id, held ? text.slice(-held) : '');
    return held ? text.slice(0, -held) : text;
  }
}
