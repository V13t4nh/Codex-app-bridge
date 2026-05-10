import { runLocalPrompt } from '../adapters/local.js';
import { loadConfig } from '../config.js';
import { CodexBridge } from '../core/codexBridge.js';
import { createLogger } from '../logger.js';

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(' ').trim() || 'Reply with exactly: bridge local e2e ok';
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const bridge = new CodexBridge({
    cdpUrl: config.codexCdpUrl,
    timeoutMs: config.codexTimeoutMs,
    logger,
    workspaceName: config.codexWorkspaceName,
    chatMode: config.codexChatMode,
  });

  try {
    const response = await runLocalPrompt(bridge, prompt);
    if (!response.trim()) throw new Error('Codex returned an empty response.');
    process.stdout.write(`${response}\n`);
  } finally {
    await bridge.close();
  }
}

main().catch((error) => {
  process.stderr.write(`local e2e failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
