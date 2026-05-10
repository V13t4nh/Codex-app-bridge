import { describe, expect, test } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  test('uses safe defaults without Telegram token', () => {
    const config = loadConfig({});
    expect(config.codexCdpUrl).toBe('http://127.0.0.1:9222');
    expect(config.telegramBotToken).toBeUndefined();
    expect(config.telegramAllowedUserIds).toEqual([]);
    expect(config.logLevel).toBe('info');
    expect(config.codexTimeoutMs).toBe(1_800_000);
    expect(config.codexWorkspaceName).toBeUndefined();
    expect(config.codexChatMode).toBe('current');
  });

  test('parses allowed user ids', () => {
    const config = loadConfig({ TELEGRAM_ALLOWED_USER_IDS: '1, 2, nope, 3', LOG_LEVEL: 'debug', CODEX_WORKSPACE_NAME: 'bridge', CODEX_CHAT_MODE: 'new' });
    expect(config.telegramAllowedUserIds).toEqual([1, 2, 3]);
    expect(config.logLevel).toBe('debug');
    expect(config.codexWorkspaceName).toBe('bridge');
    expect(config.codexChatMode).toBe('new');
  });

  test('falls back to current chat mode for invalid values', () => {
    const config = loadConfig({ CODEX_CHAT_MODE: 'invalid' });
    expect(config.codexChatMode).toBe('current');
  });

  test('parses Codex timeout override', () => {
    expect(loadConfig({ CODEX_TIMEOUT_MS: '600000' }).codexTimeoutMs).toBe(600_000);
    expect(loadConfig({ CODEX_TIMEOUT_MS: '0' }).codexTimeoutMs).toBe(1_800_000);
    expect(loadConfig({ CODEX_TIMEOUT_MS: 'nope' }).codexTimeoutMs).toBe(1_800_000);
  });
});
