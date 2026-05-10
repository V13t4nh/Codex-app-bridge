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
  checks.push(`TELEGRAM_ALLOWED_USER_IDS: ${config.telegramAllowedUserIds.length ? `set (${config.telegramAllowedUserIds.length} allowed)` : 'unset'}`);
  checks.push(`CODEX_TIMEOUT_MS: ${config.codexTimeoutMs}`);
  checks.push(`CODEX_WORKSPACE_NAME: ${config.codexWorkspaceName ?? 'unset'}`);
  checks.push(`CODEX_CHAT_MODE: ${config.codexChatMode}`);

  const bridge = new CodexBridge({
    cdpUrl: config.codexCdpUrl,
    timeoutMs: config.codexTimeoutMs,
    logger,
    workspaceName: config.codexWorkspaceName,
    chatMode: config.codexChatMode,
  });
  let failure: string | undefined;
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
    if (!result.inputSelector) failure = 'Could not find input selector. Check DOM/ARIA sample above.';
    if (!result.sendSelector) checks.push('WARN: send button not found; bridge will try Enter fallback.');
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    checks.push('CDP reachable: no');
    checks.push(`CDP error: ${failure.split('\n')[0]}`);
  } finally {
    await bridge.close();
  }

  console.log(checks.join('\n'));
  if (failure) {
    console.error(`doctor failed: ${failure}`);
    process.exit(1);
  }
}

function formatSelector(selector: { name: string; strategy: string; value: string } | undefined): string {
  return selector ? `${selector.name} (${selector.strategy}: ${selector.value})` : 'not found';
}

main().catch((error) => {
  console.error(`doctor failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
