import { loadConfig } from '../config.js';
import { CodexBridge } from '../core/codexBridge.js';
import { createLogger } from '../logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const checks: string[] = [];

  checks.push(`Node: ${process.version}`);
  checks.push(`npm: ${process.env.npm_execpath ? 'available' : 'unknown (doctor is running under npm)'}`);
  checks.push(`CODEX_CDP_URL: ${config.codexCdpUrl}`);
  checks.push(`TELEGRAM_BOT_TOKEN: ${config.telegramBotToken ? 'set' : 'unset (ok for dev/local e2e)'}`);
  checks.push(`TELEGRAM_ALLOWED_USER_IDS: ${config.telegramAllowedUserIds.length ? config.telegramAllowedUserIds.join(',') : 'unset'}`);
  checks.push(`CODEX_WORKSPACE_NAME: ${config.codexWorkspaceName ?? 'unset'}`);
  checks.push(`CODEX_CHAT_MODE: ${config.codexChatMode}`);

  const bridge = new CodexBridge({
    cdpUrl: config.codexCdpUrl,
    timeoutMs: config.codexTimeoutMs,
    logger,
    workspaceName: config.codexWorkspaceName,
    chatMode: config.codexChatMode,
  });
  try {
    const result = await bridge.discover();
    checks.push(`CDP reachable: yes`);
    checks.push(`Selected page: ${result.pageTitle} ${result.pageUrl}`);
    checks.push(`Target workspace: ${result.targetWorkspace ?? 'unset'}`);
    checks.push(`Routed/active workspace: ${result.activeWorkspace ?? 'not detected'}`);
    checks.push(`Chat mode: ${result.chatMode}`);
    checks.push(`Input selector: ${formatSelector(result.inputSelector)}`);
    checks.push(`Send selector: ${formatSelector(result.sendSelector)}`);
    checks.push(`Response selector: ${formatSelector(result.responseSelector)}`);
    checks.push('DOM/ARIA sample:');
    checks.push(...result.diagnostics.map((line) => `  - ${line}`));
    if (!result.inputSelector) throw new Error('Could not find input selector. Check DOM/ARIA sample above.');
    if (!result.sendSelector) checks.push('WARN: send button not found; bridge will try Enter fallback.');
  } finally {
    await bridge.close();
  }

  console.log(checks.join('\n'));
}

function formatSelector(selector: { name: string; strategy: string; value: string } | undefined): string {
  return selector ? `${selector.name} (${selector.strategy}: ${selector.value})` : 'not found';
}

main().catch((error) => {
  console.error(`doctor failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
