import { input, select, confirm } from '@inquirer/prompts';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import type { ConfigStore } from './config-commands.js';
import fs from 'fs';
import path from 'path';

/** Options for the init wizard */
interface InitOptions {
  /** Skip prompts and use defaults */
  yes: boolean;
  /** Path to ~/.dork directory */
  dorkHome: string;
  /** ConfigStore instance to write config */
  store: ConfigStore;
}

/**
 * Run the interactive setup wizard for DorkOS.
 *
 * @param options - Wizard options including skip flag and config store
 */
export async function runInitWizard(options: InitOptions): Promise<void> {
  const { yes, dorkHome, store } = options;
  const configPath = path.join(dorkHome, 'config.json');

  if (yes) {
    store.reset();
    console.log(`Config initialized with defaults at ${configPath}`);
    return;
  }

  if (fs.existsSync(configPath)) {
    const overwrite = await confirm({
      message: 'Config already exists. Overwrite with new settings?',
      default: false,
    });
    if (!overwrite) {
      console.log('Aborted.');
      return;
    }
  }

  console.log('\nDorkOS Setup\n');

  const portStr = await input({
    message: 'Default port:',
    default: String(USER_CONFIG_DEFAULTS.server.port),
    validate: (val) => {
      const num = Number(val);
      if (isNaN(num) || !Number.isInteger(num) || num < 1024 || num > 65535) {
        return 'Port must be an integer between 1024 and 65535';
      }
      return true;
    },
  });

  const theme = await select({
    message: 'UI theme:',
    choices: [
      { value: 'system' as const, name: 'System (follow OS)' },
      { value: 'light' as const, name: 'Light' },
      { value: 'dark' as const, name: 'Dark' },
    ],
    default: 'system',
  });

  const tunnelEnabled = await confirm({
    message: 'Enable tunnel by default?',
    default: false,
  });

  const cwd = await input({
    message: 'Default working directory (leave empty for current directory):',
    default: '',
  });

  // Apply settings
  store.reset();
  store.setDot('server.port', Number(portStr));
  store.setDot('ui.theme', theme);
  store.setDot('tunnel.enabled', tunnelEnabled);
  if (cwd && cwd.trim() !== '') {
    store.setDot('server.cwd', path.resolve(cwd));
  }

  console.log(`\nConfig saved to ${configPath}`);
}
