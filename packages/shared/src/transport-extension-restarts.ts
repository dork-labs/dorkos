/** Restarting an app after a person presses its stopped notice's action. */
export interface ExtensionRestartTransport {
  /** Restart approved code, using the same checks as reloading the app. */
  restartExtension(id: string): Promise<void>;
}
