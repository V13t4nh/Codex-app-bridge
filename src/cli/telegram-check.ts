import { Bot } from 'grammy';
import { TELEGRAM_COMMANDS } from '../adapters/telegram.js';
import { loadConfig } from '../config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN is unset.');
  if (config.telegramAllowedUserIds.length === 0) throw new Error('TELEGRAM_ALLOWED_USER_IDS is empty.');

  const bot = new Bot(config.telegramBotToken);
  const me = await bot.api.getMe();
  await bot.api.setMyCommands(TELEGRAM_COMMANDS);

  process.stdout.write(JSON.stringify({
    ok: true,
    botUsername: me.username,
    botId: me.id,
    allowedUserIdsCount: config.telegramAllowedUserIds.length,
    commandsRegistered: true,
  }, null, 2));
  process.stdout.write('\n');
}

main().catch((error) => {
  process.stderr.write(`telegram check failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
