import { performance } from 'node:perf_hooks';
import { runLocalPrompt } from '../adapters/local.js';
import { loadConfig } from '../config.js';
import { CodexBridge } from '../core/codexBridge.js';
import { createLogger } from '../logger.js';

interface BenchmarkResult {
  index: number;
  ok: boolean;
  durationMs: number;
  responseLength: number;
  preview: string;
  error?: string;
}

async function main(): Promise<void> {
  const count = parseCount(process.argv);
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const bridge = new CodexBridge({
    cdpUrl: config.codexCdpUrl,
    timeoutMs: config.codexTimeoutMs,
    logger,
    workspaceName: config.codexWorkspaceName,
    chatMode: config.codexChatMode,
  });
  const results: BenchmarkResult[] = [];

  try {
    for (let index = 1; index <= count; index += 1) {
      const prompt = `Reply exactly: bridge-perf-${index}`;
      const startedAt = performance.now();
      try {
        const response = await runLocalPrompt(bridge, prompt);
        results.push({
          index,
          ok: response.toLowerCase().includes(`bridge-perf-${index}`),
          durationMs: Math.round(performance.now() - startedAt),
          responseLength: response.length,
          preview: response.slice(0, 160),
        });
      } catch (error) {
        results.push({
          index,
          ok: false,
          durationMs: Math.round(performance.now() - startedAt),
          responseLength: 0,
          preview: '',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await bridge.close();
  }

  const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
  const summary = {
    count,
    successCount: results.filter((result) => result.ok).length,
    minMs: durations[0] ?? 0,
    avgMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations[durations.length - 1] ?? 0,
    results,
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.successCount !== count) process.exit(1);
}

function parseCount(argv: string[]): number {
  const raw = argv.find((arg) => arg.startsWith('--count='))?.slice('--count='.length);
  const parsed = Number(raw ?? '3');
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 20 ? parsed : 3;
}

function percentile(sortedValues: number[], rank: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * rank) - 1);
  return sortedValues[index] ?? 0;
}

main().catch((error) => {
  process.stderr.write(`local benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
