import type { ExtensionAPI } from '@dorkos/extension-api';

/**
 * Hello World extension — demonstrates the extension API.
 *
 * To install:
 * 1. Copy this directory to ~/.dork/extensions/hello-world/
 * 2. Open DorkOS Settings > Extensions
 * 3. Enable "Hello World"
 * 4. Reload the page
 */
export function activate(api: ExtensionAPI): () => void {
  // Register a dashboard section
  const unregisterSection = api.registerComponent(
    'dashboard.sections',
    'hello-greeting',
    HelloSection,
    { priority: 90 } // After built-in sections
  );

  // Register a command palette item
  const unregisterCommand = api.registerCommand(
    'greet',
    'Hello World: Show Greeting',
    () => {
      api.notify('Hello from the Hello World extension!', { type: 'success' });
    },
    { icon: 'hand-metal' }
  );

  // Subscribe to state changes
  const unsubscribe = api.subscribe(
    (state) => state.activeSessionId,
    (sessionId) => {
      if (sessionId) {
        console.log(`[hello-world] Active session changed: ${sessionId}`);
      }
    }
  );

  // Demonstrate persistent storage
  api.loadData<{ visits: number }>().then((data) => {
    const visits = (data?.visits ?? 0) + 1;
    api.saveData({ visits });
    console.log(`[hello-world] Visit count: ${visits}`);
  });

  // Return cleanup function (called on deactivation)
  return () => {
    console.log('[hello-world] Deactivating...');
    unregisterSection();
    unregisterCommand();
    unsubscribe();
  };
}

// A simple React component for the dashboard section.
// Note: React is provided by the host — do NOT import it in the extension bundle.
// The JSX transform handles createElement calls automatically.
function HelloSection() {
  return (
    <div style={{ padding: '16px', border: '1px solid var(--border)', borderRadius: '12px' }}>
      <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>Hello World Extension</h3>
      <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--muted-foreground)' }}>
        This section was added by the hello-world sample extension.
      </p>
    </div>
  );
}
