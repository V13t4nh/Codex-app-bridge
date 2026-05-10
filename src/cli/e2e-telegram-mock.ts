import { registerTelegramHandlers } from '../adapters/telegram.js';
import type { BridgeRequest, BridgeResponse, BridgeTarget, TextBridge, ThreadOption, WorkspaceOption } from '../core/types.js';
import { createLogger } from '../logger.js';

interface HandlerMap {
  commands: Map<string, (ctx: unknown) => Promise<unknown>>;
  events: Map<string, (ctx: unknown) => Promise<unknown>>;
}

class MockBot {
  readonly handlers: HandlerMap = { commands: new Map(), events: new Map() };

  command(command: string | string[], handler: (ctx: unknown) => Promise<unknown>): void {
    const commands = Array.isArray(command) ? command : [command];
    for (const item of commands) this.handlers.commands.set(item, handler);
  }

  on(event: string, handler: (ctx: unknown) => Promise<unknown>): void {
    this.handlers.events.set(event, handler);
  }
}

class MockBridge implements TextBridge {
  readonly calls: BridgeRequest[] = [];
  readonly openedTargets: BridgeTarget[] = [];

  async handleText(request: BridgeRequest): Promise<BridgeResponse> {
    this.calls.push(request);
    return { text: `mock-codex-response:${request.text}`, metadata: { responseLength: request.text.length } };
  }

  async newChat(): Promise<string> { return 'mock-new-chat'; }
  async stopOrPause(): Promise<string> { return 'mock-stop'; }
  async getWorkspace(): Promise<string> { return 'mock-workspace'; }
  async listWorkspaces(): Promise<WorkspaceOption[]> { return [{ name: 'bridge' }]; }
  async listThreads(): Promise<ThreadOption[]> { return [{ title: 'mock-thread' }]; }
  async openThread(target: BridgeTarget): Promise<string> { this.openedTargets.push(target); return 'mock-open-thread'; }
}

async function main(): Promise<void> {
  const logger = createLogger('error');
  const bridge = new MockBridge();
  const bot = new MockBot();
  registerTelegramHandlers(bot as never, bridge, { allowedUserIds: [123], logger });

  const replies: string[] = [];
  const inlineAnswers: unknown[] = [];
  const replyOptions: unknown[] = [];
  const baseCtx = {
    from: { id: 123 },
    reply: async (text: string, options?: unknown) => {
      replies.push(text);
      replyOptions.push(options);
      return { message_id: replies.length, chat: { id: 123 } };
    },
  };

  await bot.handlers.commands.get('start')?.(baseCtx);
  await bot.handlers.commands.get('new')?.(baseCtx);
  await bot.handlers.commands.get('workspace')?.(baseCtx);
  await bot.handlers.events.get('inline_query')?.({
    inlineQuery: { id: 'inline-1', query: '@main', from: { id: 123 } },
    answerInlineQuery: async (results: unknown[]) => { inlineAnswers.push(results); },
  });
  await bot.handlers.events.get('message:text')?.({ ...baseCtx, message: { text: 'Say exactly: bridge-ok', from: { id: 123 } } });

  if (bridge.calls.length !== 1) throw new Error(`Expected one bridge call, got ${bridge.calls.length}`);
  if (bridge.calls[0]?.text !== 'Say exactly: bridge-ok') throw new Error('Telegram message was not forwarded to bridge.');
  if (bridge.openedTargets[0]?.workspaceName !== 'Chats' || !bridge.openedTargets[0]?.newThread) throw new Error('/new did not open a new Chats thread.');
  if (inlineAnswers.length !== 1) throw new Error('Inline query was not answered.');
  if (!replyOptions.some((option) => JSON.stringify(option ?? {}).includes('inline_keyboard'))) throw new Error('Workspace menu was not sent.');
  for (const expected of ['bot ready', 'mock-codex-response']) {
    if (!replies.some((reply) => reply.includes(expected))) throw new Error(`Missing mock reply containing ${expected}`);
  }

  process.stdout.write(`mock telegram e2e passed\n${replies.join('\n')}\n`);
}

main().catch((error) => {
  process.stderr.write(`mock telegram e2e failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
