import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';

/** Page-side prevention avoids a blocked popup briefly stealing focus. The broker remains the authority. */
export function installWindowPolicy({
  control,
  report,
}: {
  control: string;
  report: string;
}): void {
  const scope = window as unknown as Record<string, unknown>;
  let held = false;
  const open = window.open.bind(window);
  Object.defineProperty(scope, control, {
    value(value: boolean) {
      held = value;
    },
  });
  window.open = (...args) => {
    if (held) return open(...args);
    const notify = scope[report] as (() => Promise<void>) | undefined;
    void notify?.().catch(() => undefined);
    return null;
  };
  document.addEventListener(
    'click',
    (event) => {
      if (held || !(event.target instanceof Element)) return;
      const link = event.target.closest('a[href],area[href]');
      if (!link) return;
      const target =
        link.getAttribute('target') ??
        document.querySelector('base[target]')?.getAttribute('target');
      if (target && target.toLowerCase() !== '_self') link.setAttribute('target', '_self');
    },
    true
  );
}

/** This changes only window policy; it reads no page content during a person's handoff. */
export class ChatWindowPolicy {
  private readonly control = `__dorkosWindow_${randomUUID().replaceAll('-', '')}`;
  private readonly report = `__dorkosPopup_${randomUUID().replaceAll('-', '')}`;
  private held = false;
  constructor(private readonly page: Page) {}
  async install(blocked: () => void): Promise<void> {
    await this.page.exposeBinding(this.report, blocked);
    await this.page.addInitScript(installWindowPolicy, {
      control: this.control,
      report: this.report,
    });
    await this.page.evaluate(installWindowPolicy, { control: this.control, report: this.report });
    this.page.on('framenavigated', () => {
      if (this.held) void this.setHeld(true).catch(() => undefined);
    });
  }
  async setHeld(held: boolean): Promise<void> {
    this.held = held;
    const update = ({ control, held }: { control: string; held: boolean }) => {
      const apply = (window as unknown as Record<string, (value: boolean) => void>)[control];
      apply?.(held);
    };
    await this.page.evaluate(update, { control: this.control, held });
    // An iframe can start OAuth too. A detached frame stays blocked and can be retried.
    await Promise.all(
      this.page
        .frames()
        .filter((frame) => frame !== this.page.mainFrame())
        .map((frame) =>
          frame.evaluate(update, { control: this.control, held }).catch(() => undefined)
        )
    );
  }
}
