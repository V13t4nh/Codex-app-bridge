import { loadConfig } from './config.js';
import { CodexBridge } from './core/codexBridge.js';
import { createLogger } from './logger.js';
import { createTelegramBot } from './adapters/telegram.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const bridge = new CodexBridge({
  cdpUrl: config.codexCdpUrl,
  timeoutMs: config.codexTimeoutMs,
  logger,
  workspaceName: config.codexWorkspaceName,
  chatMode: config.codexChatMode,
});
const bot = createTelegramBot(bridge, { token: config.telegramBotToken, allowedUserIds: config.telegramAllowedUserIds, logger });

if (!bot) {
  logger.warn('Telegram disabled; run e2e:local instead');
} else {
  logger.info('Starting Telegram bot');
  bot.start({ onStart: (info) => logger.info('Telegram bot ready', { username: info.username }) })
    .catch((error: unknown) => {
      logger.error('Telegram bot failed to start', { error: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

async function shutdown(signal: string): Promise<void> {
  logger.info('Shutting down', { signal });
  bot?.stop();
  await bridge.close();
  process.exit(0);
}
