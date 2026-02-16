import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initConfigManager } from '../config-manager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('ConfigManager', () => {
  const testDir = path.join(os.tmpdir(), 'test-dork-config-' + Date.now());
  const configPath = path.join(testDir, 'config.json');

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('creates config file on first run', () => {
    const configManager = initConfigManager(testDir);
    expect(configManager.isFirstRun).toBe(true);
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('detects existing config file', () => {
    // Create first instance
    initConfigManager(testDir);
    // Create second instance
    const configManager = initConfigManager(testDir);
    expect(configManager.isFirstRun).toBe(false);
  });

  it('returns default values on first run', () => {
    const configManager = initConfigManager(testDir);
    const config = configManager.getAll();

    expect(config.version).toBe(1);
    expect(config.server.port).toBe(4242);
    expect(config.server.cwd).toBe(null);
    expect(config.tunnel.enabled).toBe(false);
    expect(config.ui.theme).toBe('system');
  });

  it('gets top-level config section', () => {
    const configManager = initConfigManager(testDir);
    const server = configManager.get('server');

    expect(server.port).toBe(4242);
    expect(server.cwd).toBe(null);
  });

  it('gets nested value via dot-path', () => {
    const configManager = initConfigManager(testDir);
    const port = configManager.getDot('server.port');

    expect(port).toBe(4242);
  });

  it('sets top-level config section', () => {
    const configManager = initConfigManager(testDir);
    configManager.set('server', { port: 5000, cwd: '/test' });

    expect(configManager.get('server').port).toBe(5000);
    expect(configManager.get('server').cwd).toBe('/test');
  });

  it('sets nested value via dot-path', () => {
    const configManager = initConfigManager(testDir);
    configManager.setDot('server.port', 5000);

    expect(configManager.getDot('server.port')).toBe(5000);
  });

  it('warns when setting sensitive config keys', () => {
    const configManager = initConfigManager(testDir);
    const result = configManager.setDot('tunnel.authtoken', 'test-token');

    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('sensitive data');
  });

  it('does not warn for non-sensitive keys', () => {
    const configManager = initConfigManager(testDir);
    const result = configManager.setDot('server.port', 5000);

    expect(result.warning).toBeUndefined();
  });

  it('validates valid config', () => {
    const configManager = initConfigManager(testDir);
    const validation = configManager.validate();

    expect(validation.valid).toBe(true);
    expect(validation.errors).toBeUndefined();
  });

  it('resets specific key to default', () => {
    const configManager = initConfigManager(testDir);
    configManager.setDot('server.port', 5000);
    configManager.reset('server');

    expect(configManager.getDot('server.port')).toBe(4242);
  });

  it('resets all keys to defaults', () => {
    const configManager = initConfigManager(testDir);
    configManager.setDot('server.port', 5000);
    configManager.setDot('tunnel.enabled', true);
    configManager.reset();

    const config = configManager.getAll();
    expect(config.server.port).toBe(4242);
    expect(config.tunnel.enabled).toBe(false);
  });

  it('returns config file path', () => {
    const configManager = initConfigManager(testDir);
    expect(configManager.path).toBe(configPath);
  });

  it('recovers from corrupt config by creating backup', () => {
    // Create a valid config first
    const configManager1 = initConfigManager(testDir);
    configManager1.setDot('server.port', 5000);

    // Corrupt the config file
    fs.writeFileSync(configPath, '{ invalid json', 'utf-8');

    // Should recover and create backup
    const configManager2 = initConfigManager(testDir);
    const backupPath = configPath + '.bak';

    expect(fs.existsSync(backupPath)).toBe(true);
    expect(configManager2.get('server').port).toBe(4242); // Reset to defaults
  });

  it('persists config across instances', () => {
    const configManager1 = initConfigManager(testDir);
    configManager1.setDot('server.port', 5000);
    configManager1.setDot('ui.theme', 'dark');

    const configManager2 = initConfigManager(testDir);
    expect(configManager2.getDot('server.port')).toBe(5000);
    expect(configManager2.getDot('ui.theme')).toBe('dark');
  });
});
