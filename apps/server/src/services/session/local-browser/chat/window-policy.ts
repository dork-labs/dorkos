import { randomUUID } from 'node:crypto';
import type { CDPSession, Frame, Page } from 'playwright-core';
import { installWindowPolicy } from './window-guard.js';
export { installWindowPolicy } from './window-guard.js';

type PolicyConnection = {
  client: CDPSession;
  contexts: Set<number>;
  pending: Promise<void>;
  closed: boolean;
  failure?: unknown;
};

/** Policy writes and denial reports never grant user activation or read the person's page. */
export class ChatWindowPolicy {
  private readonly control = `__dorkosWindow_${randomUUID().replaceAll('-', '')}`;
  private readonly report = `__dorkosPopup_${randomUUID().replaceAll('-', '')}`;
  private readonly sessions = new Map<Page | Frame, Promise<PolicyConnection | null>>();
  private held = false;
  private closed = false;
  private blocked: () => void = () => undefined;
  constructor(private readonly page: Page) {}

  async install(blocked: () => void): Promise<void> {
    this.blocked = blocked;
    await this.page.addInitScript(installWindowPolicy, {
      control: this.control,
      report: this.report,
    });
    this.page.on('close', this.close);
    try {
      await this.refresh();
      this.page.on('framenavigated', this.navigated);
      this.page.on('framedetached', this.detached);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async setHeld(held: boolean): Promise<void> {
    this.held = held;
    await this.refresh();
  }

  private navigated = () => {
    void this.refresh().catch(() => undefined); // A new document starts blocked until updated.
  };
  private detached = (frame: Frame) => {
    const pending = this.sessions.get(frame);
    this.sessions.delete(frame);
    void pending?.then((connection) => connection?.client.detach()).catch(() => undefined);
  };
  private close = () => {
    this.closed = true;
    this.page.off('close', this.close);
    this.page.off('framenavigated', this.navigated);
    this.page.off('framedetached', this.detached);
    for (const pending of this.sessions.values())
      void pending.then((connection) => connection?.client.detach()).catch(() => undefined);
    this.sessions.clear();
  };

  private async refresh(): Promise<void> {
    if (this.closed) throw new Error('Browser window policy is closed.');
    const targets = [
      this.page,
      ...this.page.frames().filter((frame) => frame !== this.page.mainFrame()),
    ];
    const connections = await Promise.all(targets.map((target) => this.connect(target)));
    await Promise.all(
      connections.map(async (connection) => {
        if (!connection) return;
        if (connection.closed) throw new Error('Browser window policy disconnected.');
        connection.failure = undefined;
        for (const id of connection.contexts)
          void this.update(connection, id).catch(() => undefined);
        await connection.pending;
        if (connection.closed) throw new Error('Browser window policy disconnected.');
        if (connection.failure) throw connection.failure;
      })
    );
  }

  private connect(target: Page | Frame): Promise<PolicyConnection | null> {
    const existing = this.sessions.get(target);
    if (existing) return existing;
    const pending = this.acquire(target);
    this.sessions.set(target, pending);
    void pending.then(
      (connection) => {
        if (!connection && this.sessions.get(target) === pending) this.sessions.delete(target);
      },
      () => {
        if (this.sessions.get(target) === pending) this.sessions.delete(target);
      }
    );
    return pending;
  }

  private async acquire(target: Page | Frame): Promise<PolicyConnection | null> {
    let client: CDPSession;
    try {
      client = await this.page.context().newCDPSession(target);
    } catch (error) {
      // Same-process iframes are covered by their parent's default execution contexts.
      if (target !== this.page && String(error).includes("part of the parent frame's session"))
        return null;
      throw error;
    }
    const connection: PolicyConnection = {
      client,
      contexts: new Set(),
      pending: Promise.resolve(),
      closed: false,
    };
    client.on('close', () => {
      connection.closed = true;
      const registered = this.sessions.get(target);
      void registered
        ?.then((known) => {
          if (known === connection && this.sessions.get(target) === registered)
            this.sessions.delete(target);
        })
        .catch(() => undefined);
    });
    client.on('Runtime.executionContextCreated', ({ context }) => {
      if (!context.auxData?.isDefault) return;
      connection.contexts.add(context.id);
      void this.update(connection, context.id).catch(() => undefined);
    });
    client.on('Runtime.executionContextDestroyed', ({ executionContextId }) =>
      connection.contexts.delete(executionContextId)
    );
    client.on('Runtime.executionContextsCleared', () => connection.contexts.clear());
    client.on('Runtime.bindingCalled', (event) => {
      if (event.name === this.report && connection.contexts.has(event.executionContextId))
        this.blocked();
    });
    try {
      if (this.closed) throw new Error('Browser window policy is closed.');
      await client.send('Runtime.addBinding', { name: this.report });
      await client.send('Runtime.enable');
      await connection.pending;
      if (connection.failure) throw connection.failure;
      if (!connection.contexts.size) throw new Error('Browser window policy has no main document.');
      return connection;
    } catch (error) {
      await client.detach().catch(() => undefined);
      throw error;
    }
  }

  private update(connection: PolicyConnection, contextId: number): Promise<void> {
    connection.pending = connection.pending
      .catch(() => undefined)
      .then(async () => {
        if (connection.closed || this.closed || !connection.contexts.has(contextId)) return;
        const expression = `(${installWindowPolicy.toString()})(${JSON.stringify({ control: this.control, report: this.report })});window[${JSON.stringify(this.control)}](${this.held})`;
        const result = await connection.client.send(
          'Runtime.evaluate',
          {
            expression,
            contextId,
            userGesture: false,
            returnByValue: true,
          },
          { timeout: 3000 }
        );
        if (result.exceptionDetails) throw new Error('Browser window policy could not be applied.');
      })
      .catch((error: unknown) => {
        connection.failure = error;
        throw error;
      });
    return connection.pending;
  }
}
