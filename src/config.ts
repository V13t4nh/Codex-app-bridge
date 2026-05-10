import 'dotenv/config';
import type { ChatMode } from './core/types.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  codexCdpUrl: string;
  telegramBotToken?: string;
  telegramAllowedUserIds: number[];
  logLevel: LogLevel;
  codexTimeoutMs: number;
  codexWorkspaceName?: string;
  codexChatMode: ChatMode;
}

const DEFAULT_CODEX_CDP_URL = 'http://127.0.0.1:9222';
const DEFAULT_CODEX_TIMEOUT_MS = 180_000;
const LOG_LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error']);
const CHAT_MODES = new Set<ChatMode>(['current', 'new']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const logLevel = env.LOG_LEVEL && LOG_LEVELS.has(env.LOG_LEVEL as LogLevel)
    ? env.LOG_LEVEL as LogLevel
    : 'info';
  const codexChatMode = env.CODEX_CHAT_MODE && CHAT_MODES.has(env.CODEX_CHAT_MODE as ChatMode)
    ? env.CODEX_CHAT_MODE as ChatMode
    : 'current';

  return {
    codexCdpUrl: env.CODEX_CDP_URL?.trim() || DEFAULT_CODEX_CDP_URL,
    telegramBotToken: emptyToUndefined(env.TELEGRAM_BOT_TOKEN),
    telegramAllowedUserIds: parseAllowedUserIds(env.TELEGRAM_ALLOWED_USER_IDS),
    logLevel,
    codexTimeoutMs: DEFAULT_CODEX_TIMEOUT_MS,
    codexWorkspaceName: emptyToUndefined(env.CODEX_WORKSPACE_NAME),
    codexChatMode,
  };
}

function parseAllowedUserIds(raw?: string): number[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value));
}

function emptyToUndefined(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
