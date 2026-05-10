import { afterEach, describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createLogger } from '../logger.js';
import { buildTelegramCommands, registerTelegramHandlers, splitTelegramText, TELEGRAM_COMMANDS, TELEGRAM_MESSAGE_COALESCE_MS, type TelegramSkillCommand } from './telegram.js';
import type { TextBridge, BridgeRequest, BridgeResponse, BridgeTarget, ThreadOption, WorkspaceOption } from '../core/types.js';

class FakeBridge implements TextBridge {
  requests: BridgeRequest[] = [];
  stopCalls = 0;
  workspaceCalls = 0;
  listWorkspaceCalls = 0;
  listThreadCalls: string[] = [];
  openedTargets: BridgeTarget[] = [];

  constructor(
    private readonly workspaces: WorkspaceOption[] = [{ name: 'bridge' }, { name: 'sandbox' }],
    private readonly threads: ThreadOption[] = [{ title: 'Existing thread' }, { title: 'Another thread' }],
  ) {}

  async handleText(request: BridgeRequest): Promise<BridgeResponse> {
    this.requests.push(request);
    if (request.text === 'formatted') {
      return { text: 'formatted answer', formattedText: '<b>formatted</b> answer', format: 'html', metadata: { responseLength: 16 } };
    }
    return { text: `ok:${request.text}`, metadata: { responseLength: request.text.length } };
  }
  async stopOrPause(): Promise<string> { this.stopCalls += 1; return 'stop-ok'; }
  async getWorkspace(): Promise<string> { this.workspaceCalls += 1; return 'workspace-ok'; }
  async listWorkspaces(): Promise<WorkspaceOption[]> {
    this.listWorkspaceCalls += 1;
    return this.workspaces;
  }
  async listThreads(workspaceName: string): Promise<ThreadOption[]> {
    this.listThreadCalls.push(workspaceName);
    return this.threads;
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

function registerFakeHandlers(bot: FakeBot, bridge: TextBridge, allowedUserIds = [1], token?: string, skillCommands?: TelegramSkillCommand[]): void {
  registerTelegramHandlers(bot as never, bridge, { allowedUserIds, token, skillCommands, logger: createLogger('error') });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function flushTelegramQueue(): Promise<void> {
  await vi.advanceTimersByTimeAsync(TELEGRAM_MESSAGE_COALESCE_MS + 1);
  await Promise.resolve();
  await Promise.resolve();
}

describe('telegram adapter', () => {
  test('forwards text messages to bridge', async () => {
    vi.useFakeTimers();
    const bridge = new FakeBridge();
    const bot = new FakeBot();
    const replies: string[] = [];
    registerFakeHandlers(bot, bridge);

    await bot.events.get('message:text')?.({ from: { id: 1 }, message: { text: 'hello', from: { id: 1 } }, reply: async (text: string) => replies.push(text) });
    await flushTelegramQueue();

    expect(bridge.requests).toHaveLength(1);
    expect(bridge.requests[0]).toMatchObject({ text: 'hello', source: 'telegram', userId: 1 });
    expect(replies[0]).toContain('Codex');
    expect(replies.at(-1)).toBe('ok:hello');
  });

  test('uses Telegram HTML parse mode when the bridge provides formatted text', async () => {
    vi.useFakeTimers();
    const bridge = new FakeBridge();
    const bot = new FakeBot();
    const replies: Array<{ text: string; options?: { parse_mode?: 'HTML' } }> = [];
    registerFakeHandlers(bot, bridge);

    await bot.events.get('message:text')?.({
      from: { id: 1 },
      message: { text: 'formatted', from: { id: 1 } },
      reply: async (text: string, options?: { parse_mode?: 'HTML' }) => replies.push({ text, options }),
    });
    await flushTelegramQueue();

    expect(replies[0]?.text).toContain('Codex');
    expect(replies.at(-1)).toEqual({ text: '<b>formatted</b> answer', options: { parse_mode: 'HTML' } });
  });

  test('handles commands without calling text bridge', async () => {
    const bridge = new FakeBridge();
    const bot = new FakeBot();
    const replies: string[] = [];
    registerFakeHandlers(bot, bridge);

    const ctx = {
      from: { id: 1 },
      chat: { id: 10 },
      message: { message_id: 100, from: { id: 1 }, chat: { id: 10 } },
      reply: async (text: string) => replies.push(text),
    };
    await bot.commands.get('start')?.(ctx);
    await bot.commands.get('stop')?.(ctx);

    expect(bridge.requests).toHaveLength(0);
    expect(replies.join('\n')).toContain('bot ready');
    expect(replies).toContain('stop-ok');
    expect(bridge.openedTargets).toEqual([]);
    expect(bot.commands.has('new')).toBe(false);
    expect(bot.commands.has('pause')).toBe(false);
  });

  test('reports status and clears the Telegram routing session', async () => {
    vi.useFakeTimers();
    const bridge = new FakeBridge();
    const bot = new FakeBot();
    const replies: Array<{ text: string; options?: { reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } } }> = [];
    const deleted: Array<[number, number]> = [];
    registerFakeHandlers(bot, bridge);

    const ctx = {
      from: { id: 1 },
      chat: { id: 10 },
      message: { message_id: 100, text: '/workspace', from: { id: 1 }, chat: { id: 10 } },
      api: { deleteMessage: async (chatId: number, messageId: number) => { deleted.push([chatId, messageId]); } },
      reply: async (text: string, options?: { reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }) => {
        replies.push({ text, options });
        return { message_id: 101 + replies.length, chat: { id: 10 } };
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
    const threadKeyboard = replies[1]?.options?.reply_markup?.inline_keyboard;
    const newButton = threadKeyboard?.flat().find((button) => button.text === '+ New');
    expect(newButton?.callback_data).toBeTruthy();

    await bot.events.get('callback_query:data')?.({
      ...ctx,
      callbackQuery: { id: 'cb-2', data: newButton?.callback_data, from: { id: 1 }, message: { message_id: 102, chat: { id: 10 } } },
      answerCallbackQuery: async () => undefined,
    });
    await bot.commands.get('status')?.({ ...ctx, message: { ...ctx.message, text: '/status' } });
    await bot.commands.get('clear')?.({ ...ctx, message: { ...ctx.message, text: '/clear' } });
    await bot.events.get('message:text')?.({ ...ctx, message: { message_id: 103, text: 'hello', from: { id: 1 }, chat: { id: 10 } } });
    await flushTelegramQueue();

    expect(replies.map((reply) => reply.text).join('\n')).toContain('Telegram route: bridge: New');
    expect(replies.map((reply) => reply.text).join('\n')).toContain('workspace-ok');
    expect(bridge.openedTargets).toContainEqual({ workspaceName: 'bridge' });
    expect(bridge.openedTargets).toContainEqual({ workspaceName: 'bridge', newThread: true });
    expect(bridge.requests[0]).toMatchObject({ text: 'hello' });
    expect(bridge.requests[0]?.target).toBeUndefined();
    expect(deleted.length).toBeGreaterThan(0);
  });

  test('opens workspace and thread menus then routes messages to selected thread', async () => {
    vi.useFakeTimers();
    const bridge = new FakeBridge();
    const bot = new FakeBot();
    const replies: Array<{ text: string; options?: { reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } } }> = [];
    const deleted: Array<[number, number]> = [];
    registerFakeHandlers(bot, bridge);

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
    await flushTelegramQueue();

    expect(bridge.openedTargets).toEqual([{ workspaceName: 'bridge' }, { workspaceName: 'bridge', threadTitle: 'Existing thread' }]);
    expect(bridge.requests[0]).toMatchObject({
      text: 'hello',
      target: { workspaceName: 'bridge', threadTitle: 'Existing thread' },
    });
    expect(deleted.length).toBeGreaterThan(0);
  });

  test('workspace selection preserves list order, truncates labels, and routes immediately', async () => {
    vi.useFakeTimers();
    const longWorkspace = `research workspace ${'with a long title '.repeat(5)}`.trim();
    const bridge = new FakeBridge([{ name: 'alpha' }, { name: longWorkspace }, { name: 'omega' }]);
    const bot = new FakeBot();
    const replies: Array<{ text: string; options?: { reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } } }> = [];
    registerFakeHandlers(bot, bridge);

    const ctx = {
      from: { id: 1 },
      chat: { id: 10 },
      message: { message_id: 100, text: '/workspace', from: { id: 1 }, chat: { id: 10 } },
      api: { deleteMessage: async () => undefined },
      reply: async (text: string, options?: { reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }) => {
        const message = { message_id: 101 + replies.length, chat: { id: 10 } };
        replies.push({ text, options });
        return message;
      },
    };

    await bot.commands.get('workspace')?.(ctx);
    const buttons = replies[0]?.options?.reply_markup?.inline_keyboard.flat() ?? [];
    expect(buttons.map((button) => button.text)).toHaveLength(3);
    expect(buttons[0]?.text).toBe('alpha');
    expect(buttons[1]?.text.length).toBeLessThanOrEqual(64);
    expect(buttons[1]?.text).toMatch(/\.\.\.$/);
    expect(buttons[2]?.text).toBe('omega');

    await bot.events.get('callback_query:data')?.({
      ...ctx,
      callbackQuery: { id: 'cb-1', data: buttons[1]?.callback_data, from: { id: 1 }, message: { message_id: 101, chat: { id: 10 } } },
      answerCallbackQuery: async () => undefined,
    });
    await bot.events.get('message:text')?.({ ...ctx, message: { message_id: 103, text: 'hello', from: { id: 1 }, chat: { id: 10 } } });
    await flushTelegramQueue();

    expect(bridge.openedTargets).toEqual([{ workspaceName: longWorkspace }]);
    expect(bridge.listThreadCalls).toEqual([longWorkspace]);
    expect(bridge.requests[0]?.target).toEqual({ workspaceName: longWorkspace });
  });

  test('clear all resets routing and deletes recent Telegram chat messages', async () => {
    vi.useFakeTimers();
    const bridge = new FakeBridge();
    const bot = new FakeBot();
    const replies: Array<{ text: string; options?: { reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } } }> = [];
    const deleted: Array<[number, number]> = [];
    registerFakeHandlers(bot, bridge);

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
    const workspaceButton = replies[0]?.options?.reply_markup?.inline_keyboard.flat().find((button) => button.text === 'bridge');
    await bot.events.get('callback_query:data')?.({
      ...ctx,
      callbackQuery: { id: 'cb-1', data: workspaceButton?.callback_data, from: { id: 1 }, message: { message_id: 101, chat: { id: 10 } } },
      answerCallbackQuery: async () => undefined,
    });
    await bot.commands.get('clear_all')?.({ ...ctx, message: { message_id: 110, text: '/clear_all', from: { id: 1 }, chat: { id: 10 } } });

    expect(deleted).toContainEqual([10, 110]);
    expect(deleted).toContainEqual([10, 1]);

    await bot.events.get('message:text')?.({ ...ctx, message: { message_id: 111, text: 'hello', from: { id: 1 }, chat: { id: 10 } } });
    await flushTelegramQueue();

    expect(bridge.requests[0]).toMatchObject({ text: 'hello' });
    expect(bridge.requests[0]?.target).toBeUndefined();
  });

  test('clear all skips missing messages and stops at non-deletable history boundary', async () => {
    const bridge = new FakeBridge();
    const bot = new FakeBot();
    const attempted: number[] = [];
    registerFakeHandlers(bot, bridge);

    await bot.commands.get('clear_all')?.({
      from: { id: 1 },
      chat: { id: 10 },
      message: { message_id: 110, text: '/clear_all', from: { id: 1 }, chat: { id: 10 } },
      api: {
        deleteMessage: async (_chatId: number, messageId: number) => {
          attempted.push(messageId);
          if (messageId === 108) throw new Error("Call to 'deleteMessage' failed! (400: Bad Request: message to delete not found)");
          if (messageId === 105) throw new Error("Call to 'deleteMessage' failed! (400: Bad Request: message can't be deleted for everyone)");
        },
      },
      reply: async () => undefined,
    });

    expect(attempted).toEqual([110, 109, 108, 107, 106, 105]);
  });

  test('coalesces rapid split text messages into one multiline prompt', async () => {
    vi.useFakeTimers();
    const bridge = new FakeBridge();
    const bot = new FakeBot();
    const replies: string[] = [];
    registerFakeHandlers(bot, bridge);

    await bot.events.get('message:text')?.({ from: { id: 1 }, message: { text: 'first line', from: { id: 1 } }, reply: async (text: string) => replies.push(text) });
    await bot.events.get('message:text')?.({ from: { id: 1 }, message: { text: 'second line', from: { id: 1 } }, reply: async (text: string) => replies.push(text) });
    expect(bridge.requests).toHaveLength(0);
    await flushTelegramQueue();

    expect(bridge.requests).toHaveLength(1);
    expect(bridge.requests[0]?.text).toBe('first line\nsecond line');
    expect(replies.at(-1)).toBe('ok:first line\nsecond line');
  });

  test('downloads Telegram documents and forwards a local file reference', async () => {
    const bridge = new FakeBridge();
    const bot = new FakeBot();
    const replies: string[] = [];
    registerFakeHandlers(bot, bridge, [1], 'test-token');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => new Uint8Array([104, 101, 108, 108, 111]).buffer,
    })));

    await bot.events.get('message:document')?.({
      from: { id: 1 },
      chat: { id: 10 },
      message: {
        message_id: 77,
        from: { id: 1 },
        chat: { id: 10 },
        caption: 'summarize this',
        document: { file_id: 'file-1', file_name: 'note.txt', file_size: 5, mime_type: 'text/plain' },
      },
      api: {
        deleteMessage: async () => undefined,
        getFile: async () => ({ file_path: 'documents/file_1.txt', file_size: 5 }),
      },
      reply: async (text: string) => {
        replies.push(text);
        return { message_id: 88 + replies.length, chat: { id: 10 } };
      },
    });

    expect(bridge.requests).toHaveLength(1);
    const prompt = bridge.requests[0]?.text ?? '';
    expect(prompt).toContain('Telegram document received: note.txt');
    expect(prompt).toContain('MIME type: text/plain');
    expect(prompt).toContain('Caption:\nsummarize this');
    const localPath = prompt.match(/^Local path: (.+)$/m)?.[1];
    expect(localPath).toBeTruthy();
    await expect(readFile(localPath ?? '', 'utf8')).resolves.toBe('hello');
    expect(replies.at(-1)).toContain('ok:Telegram document received: note.txt');
  });

  test('forwards Telegram skill slash aliases as Codex skill prompts', async () => {
    const bridge = new FakeBridge();
    const bot = new FakeBot();
    const replies: string[] = [];
    registerFakeHandlers(bot, bridge, [1], undefined, [{
      command: 'frontend_ui_ux',
      skillName: 'frontend-ui-ux',
      description: 'Run $frontend-ui-ux',
    }]);

    await bot.commands.get('frontend_ui_ux')?.({
      from: { id: 1 },
      message: { text: '/frontend_ui_ux polish this UI', from: { id: 1 } },
      reply: async (text: string) => replies.push(text),
    });

    expect(bridge.requests[0]).toMatchObject({
      text: '$frontend-ui-ux polish this UI',
      source: 'telegram',
      userId: 1,
    });
    expect(replies.at(-1)).toBe('ok:$frontend-ui-ux polish this UI');
  });

  test('registers only the non-duplicate slash commands', () => {
    expect(TELEGRAM_COMMANDS.map((command) => command.command)).toEqual(['workspace', 'stop', 'status', 'clear', 'clear_all']);
  });

  test('builds Telegram menu commands with skill aliases', () => {
    const commands = buildTelegramCommands([{ command: 'frontend_ui_ux', skillName: 'frontend-ui-ux', description: 'Run $frontend-ui-ux' }]);

    expect(commands.map((command) => command.command)).toContain('frontend_ui_ux');
  });

  test('denies commands for users outside allowlist', async () => {
    const bridge = new FakeBridge();
    const bot = new FakeBot();
    const replies: string[] = [];
    registerFakeHandlers(bot, bridge, [2]);

    const ctx = { from: { id: 1 }, reply: async (text: string) => replies.push(text) };
    await bot.commands.get('stop')?.(ctx);
    await bot.commands.get('workspace')?.(ctx);
    await bot.commands.get('status')?.(ctx);
    await bot.commands.get('clear')?.(ctx);
    await bot.commands.get('clear_all')?.(ctx);

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
    registerFakeHandlers(bot, bridge, [2]);

    await bot.commands.get('start')?.({ from: { id: 123 }, reply: async (text: string) => replies.push(text) });

    expect(replies).toEqual(['Access denied. Your Telegram user id is 123.']);
  });
});
