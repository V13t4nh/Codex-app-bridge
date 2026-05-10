import { describe, expect, test } from 'vitest';
import { createLogger } from '../logger.js';
import { registerTelegramHandlers, splitTelegramText, TELEGRAM_COMMANDS } from './telegram.js';
import type { TextBridge, BridgeRequest, BridgeResponse, BridgeTarget, ThreadOption, WorkspaceOption } from '../core/types.js';

class FakeBridge implements TextBridge {
  requests: BridgeRequest[] = [];
  newChatCalls = 0;
  stopCalls = 0;
  workspaceCalls = 0;
  listWorkspaceCalls = 0;
  listThreadCalls: string[] = [];
  openedTargets: BridgeTarget[] = [];

  async handleText(request: BridgeRequest): Promise<BridgeResponse> {
    this.requests.push(request);
    if (request.text === 'formatted') {
      return { text: 'formatted answer', formattedText: '<b>formatted</b> answer', format: 'html', metadata: { responseLength: 16 } };
    }
    return { text: `ok:${request.text}`, metadata: { responseLength: request.text.length } };
  }
  async newChat(): Promise<string> { this.newChatCalls += 1; return 'new-ok'; }
  async stopOrPause(): Promise<string> { this.stopCalls += 1; return 'stop-ok'; }
  async getWorkspace(): Promise<string> { this.workspaceCalls += 1; return 'workspace-ok'; }
  async listWorkspaces(): Promise<WorkspaceOption[]> {
    this.listWorkspaceCalls += 1;
    return [{ name: 'bridge' }, { name: 'sandbox' }];
  }
  async listThreads(workspaceName: string): Promise<ThreadOption[]> {
    this.listThreadCalls.push(workspaceName);
    return [{ title: 'Existing thread' }, { title: 'Another thread' }];
  }
  async openThread(target: BridgeTarget): Promise<string> {
    this.openedTargets.push(target);
    return 'thread-opened';
  }
}

class FakeBot {
  commands = new Map<string, (ctx: unknown) => Promise<unknown>>();
  events = new Map<string, (ctx: unknown) => Promise<unknown>>();
  command(command: string | string[], handler: (ctx: unknown) => Promise<unknown>): void {
    for (const item of Array.isArray(command) ? command : [command]) this.commands.set(item, handler);
  }
  on(event: string, handler: (ctx: unknown) => Promise<unknown>): void {
    this.events.set(event, handler);
  }
}

describe('telegram adapter', () => {
  test('forwards text messages to bridge', async () => {
    const bridge = new FakeBridge();
    const bot = new FakeBot();
    const replies: string[] = [];
    registerTelegramHandlers(bot as never, bridge, { allowedUserIds: [1], logger: createLogger('error') });

    await bot.events.get('message:text')?.({ from: { id: 1 }, message: { text: 'hello', from: { id: 1 } }, reply: async (text: string) => replies.push(text) });

    expect(bridge.requests).toHaveLength(1);
    expect(bridge.requests[0]).toMatchObject({ text: 'hello', source: 'telegram', userId: 1 });
    expect(replies).toEqual(['ok:hello']);
  });

  test('uses Telegram HTML parse mode when the bridge provides formatted text', async () => {
    const bridge = new FakeBridge();
    const bot = new FakeBot();
    const replies: Array<{ text: string; options?: { parse_mode?: 'HTML' } }> = [];
    registerTelegramHandlers(bot as never, bridge, { allowedUserIds: [1], logger: createLogger('error') });

    await bot.events.get('message:text')?.({
      from: { id: 1 },
      message: { text: 'formatted', from: { id: 1 } },
      reply: async (text: string, options?: { parse_mode?: 'HTML' }) => replies.push({ text, options }),
    });

    expect(replies).toEqual([{ text: '<b>formatted</b> answer', options: { parse_mode: 'HTML' } }]);
  });

  test('handles commands without calling text bridge', async () => {
    const bridge = new FakeBridge();
    const bot = new FakeBot();
    const replies: string[] = [];
    const deleted: Array<[number, number]> = [];
    registerTelegramHandlers(bot as never, bridge, { allowedUserIds: [1], logger: createLogger('error') });

    const ctx = {
      from: { id: 1 },
      chat: { id: 10 },
      message: { message_id: 100, from: { id: 1 }, chat: { id: 10 } },
      api: { deleteMessage: async (chatId: number, messageId: number) => { deleted.push([chatId, messageId]); } },
      reply: async (text: string) => replies.push(text),
    };
    await bot.commands.get('start')?.(ctx);
    await bot.commands.get('new')?.(ctx);
    await bot.commands.get('stop')?.(ctx);

    expect(bridge.requests).toHaveLength(0);
    expect(replies.join('\n')).toContain('bot ready');
    expect(replies).toContain('stop-ok');
    expect(bridge.openedTargets).toContainEqual({ workspaceName: 'Chats', newThread: true });
    expect(deleted.length).toBeGreaterThan(0);
    expect(bot.commands.has('pause')).toBe(false);
  });

  test('reports status and clears the Telegram routing session', async () => {
    const bridge = new FakeBridge();
    const bot = new FakeBot();
    const replies: string[] = [];
    const deleted: Array<[number, number]> = [];
    registerTelegramHandlers(bot as never, bridge, { allowedUserIds: [1], logger: createLogger('error') });

    const ctx = {
      from: { id: 1 },
      chat: { id: 10 },
      message: { message_id: 100, text: '/new', from: { id: 1 }, chat: { id: 10 } },
      api: { deleteMessage: async (chatId: number, messageId: number) => { deleted.push([chatId, messageId]); } },
      reply: async (text: string) => {
        replies.push(text);
        return { message_id: 101 + replies.length, chat: { id: 10 } };
      },
    };

    await bot.commands.get('new')?.(ctx);
    await bot.commands.get('status')?.({ ...ctx, message: { ...ctx.message, text: '/status' } });
    await bot.commands.get('clear')?.({ ...ctx, message: { ...ctx.message, text: '/clear' } });
    await bot.events.get('message:text')?.({ ...ctx, message: { message_id: 103, text: 'hello', from: { id: 1 }, chat: { id: 10 } } });

    expect(replies.join('\n')).toContain('Telegram route: Chats: New');
    expect(replies.join('\n')).toContain('workspace-ok');
    expect(bridge.requests[0]).toMatchObject({ text: 'hello' });
    expect(bridge.requests[0]?.target).toBeUndefined();
    expect(deleted.length).toBeGreaterThan(0);
  });

  test('opens workspace and thread menus then routes messages to selected thread', async () => {
    const bridge = new FakeBridge();
    const bot = new FakeBot();
    const replies: Array<{ text: string; options?: { reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } } }> = [];
    const deleted: Array<[number, number]> = [];
    registerTelegramHandlers(bot as never, bridge, { allowedUserIds: [1], logger: createLogger('error') });

    const ctx = {
      from: { id: 1 },
      chat: { id: 10 },
      message: { message_id: 100, text: '/workspace', from: { id: 1 }, chat: { id: 10 } },
      api: { deleteMessage: async (chatId: number, messageId: number) => { deleted.push([chatId, messageId]); } },
      reply: async (text: string, options?: { reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }) => {
        const message = { message_id: 101 + replies.length, chat: { id: 10 } };
        replies.push({ text, options });
        return message;
      },
    };

    await bot.commands.get('workspace')?.(ctx);
    const workspaceKeyboard = replies[0]?.options?.reply_markup?.inline_keyboard;
    const bridgeButton = workspaceKeyboard?.flat().find((button) => button.text === 'bridge');
    expect(bridgeButton?.callback_data).toBeTruthy();

    await bot.events.get('callback_query:data')?.({
      ...ctx,
      callbackQuery: { id: 'cb-1', data: bridgeButton?.callback_data, from: { id: 1 }, message: { message_id: 101, chat: { id: 10 } } },
      answerCallbackQuery: async () => undefined,
    });

    expect(bridge.listThreadCalls).toEqual(['bridge']);
    expect(replies[1]?.text).toContain('Workspace: bridge');
    const threadKeyboard = replies[1]?.options?.reply_markup?.inline_keyboard;
    expect(threadKeyboard?.[0]?.[0]?.text).toBe('+ New');
    const threadButton = threadKeyboard?.flat().find((button) => button.text === 'Existing thread');
    expect(threadButton?.callback_data).toBeTruthy();

    await bot.events.get('callback_query:data')?.({
      ...ctx,
      callbackQuery: { id: 'cb-2', data: threadButton?.callback_data, from: { id: 1 }, message: { message_id: 102, chat: { id: 10 } } },
      answerCallbackQuery: async () => undefined,
    });

    await bot.events.get('message:text')?.({ ...ctx, message: { message_id: 103, text: 'hello', from: { id: 1 }, chat: { id: 10 } } });

    expect(bridge.openedTargets).toEqual([{ workspaceName: 'bridge', threadTitle: 'Existing thread' }]);
    expect(bridge.requests[0]).toMatchObject({
      text: 'hello',
      target: { workspaceName: 'bridge', threadTitle: 'Existing thread' },
    });
    expect(deleted.length).toBeGreaterThan(0);
  });

  test('registers only the non-duplicate slash commands', () => {
    expect(TELEGRAM_COMMANDS.map((command) => command.command)).toEqual(['workspace', 'new', 'stop', 'status', 'clear']);
  });

  test('denies commands for users outside allowlist', async () => {
    const bridge = new FakeBridge();
    const bot = new FakeBot();
    const replies: string[] = [];
    registerTelegramHandlers(bot as never, bridge, { allowedUserIds: [2], logger: createLogger('error') });

    const ctx = { from: { id: 1 }, reply: async (text: string) => replies.push(text) };
    await bot.commands.get('new')?.(ctx);
    await bot.commands.get('stop')?.(ctx);
    await bot.commands.get('workspace')?.(ctx);
    await bot.commands.get('status')?.(ctx);
    await bot.commands.get('clear')?.(ctx);

    expect(bridge.newChatCalls).toBe(0);
    expect(bridge.stopCalls).toBe(0);
    expect(bridge.listWorkspaceCalls).toBe(0);
    expect(replies).toEqual(['Access denied.', 'Access denied.', 'Access denied.', 'Access denied.', 'Access denied.']);
  });

  test('splits long Telegram replies into sendable chunks', async () => {
    const chunks = splitTelegramText(`${'a'.repeat(8)}\n${'b'.repeat(8)}`, 10);

    expect(chunks).toEqual(['aaaaaaaa', 'bbbbbbbb']);
  });

  test('replies with denied user id on start for bootstrap', async () => {
    const bridge = new FakeBridge();
    const bot = new FakeBot();
    const replies: string[] = [];
    registerTelegramHandlers(bot as never, bridge, { allowedUserIds: [2], logger: createLogger('error') });

    await bot.commands.get('start')?.({ from: { id: 123 }, reply: async (text: string) => replies.push(text) });

    expect(replies).toEqual(['Access denied. Your Telegram user id is 123.']);
  });
});
