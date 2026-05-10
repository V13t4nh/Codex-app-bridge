import { registerTelegramHandlers, TELEGRAM_MESSAGE_COALESCE_MS } from '../adapters/telegram.js';
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
  await bot.handlers.commands.get('workspace')?.(baseCtx);
  const workspaceButton = findInlineButton(replyOptions, 'bridge');
  if (!workspaceButton?.callback_data) throw new Error('/workspace did not send a bridge workspace button.');
  await bot.handlers.events.get('callback_query:data')?.({
    ...baseCtx,
    callbackQuery: { id: 'cb-workspace', data: workspaceButton.callback_data, from: { id: 123 }, message: { message_id: replies.length, chat: { id: 123 } } },
    answerCallbackQuery: async () => undefined,
  });
  const newThreadButton = findInlineButton(replyOptions, '+ New');
  if (!newThreadButton?.callback_data) throw new Error('/workspace did not expose a + New thread button.');
  await bot.handlers.events.get('callback_query:data')?.({
    ...baseCtx,
    callbackQuery: { id: 'cb-new-thread', data: newThreadButton.callback_data, from: { id: 123 }, message: { message_id: replies.length, chat: { id: 123 } } },
    answerCallbackQuery: async () => undefined,
  });
  await bot.handlers.events.get('inline_query')?.({
    inlineQuery: { id: 'inline-1', query: '@main', from: { id: 123 } },
    answerInlineQuery: async (results: unknown[]) => { inlineAnswers.push(results); },
  });
  await bot.handlers.events.get('message:text')?.({ ...baseCtx, message: { text: 'Say exactly: bridge-ok', from: { id: 123 } } });
  await sleep(TELEGRAM_MESSAGE_COALESCE_MS + 20);

  if (bridge.calls.length !== 1) throw new Error(`Expected one bridge call, got ${bridge.calls.length}`);
  if (bridge.calls[0]?.text !== 'Say exactly: bridge-ok') throw new Error('Telegram message was not forwarded to bridge.');
  if (bridge.calls[0]?.target?.workspaceName !== 'bridge') throw new Error('Telegram message did not use the selected workspace route.');
  if (bridge.openedTargets[0]?.workspaceName !== 'bridge') throw new Error('/workspace selection did not open the bridge workspace.');
  if (bridge.openedTargets[1]?.workspaceName !== 'bridge' || !bridge.openedTargets[1]?.newThread) throw new Error('/workspace + New selection did not open a new bridge thread.');
  if (inlineAnswers.length !== 1) throw new Error('Inline query was not answered.');
  if (!replyOptions.some((option) => JSON.stringify(option ?? {}).includes('inline_keyboard'))) throw new Error('Workspace menu was not sent.');
  for (const expected of ['bot ready', 'mock-codex-response']) {
    if (!replies.some((reply) => reply.includes(expected))) throw new Error(`Missing mock reply containing ${expected}`);
  }

  process.stdout.write(`mock telegram e2e passed\n${replies.join('\n')}\n`);
}

function findInlineButton(options: unknown[], text: string): { text: string; callback_data?: string } | undefined {
  for (const option of options) {
    const keyboard = (option as { reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> } } | undefined)?.reply_markup?.inline_keyboard;
    const button = keyboard?.flat().find((item) => item.text === text);
    if (button) return button;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  process.stderr.write(`mock telegram e2e failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
