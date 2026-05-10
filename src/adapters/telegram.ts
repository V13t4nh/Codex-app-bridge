import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { InlineQueryResultArticle } from '@grammyjs/types';
import type { BridgeResponse, BridgeTarget, TextBridge, ThreadOption, WorkspaceOption } from '../core/types.js';
import type { Logger } from '../logger.js';

const MAX_TELEGRAM_MESSAGE_LENGTH = 3_900;

export const TELEGRAM_COMMANDS = [
  { command: 'workspace', description: 'Choose Codex workspace and thread' },
  { command: 'new', description: 'Start a new thread in the selected workspace' },
  { command: 'stop', description: 'Stop the active Codex response' },
  { command: 'status', description: 'Show current routing and Codex workspace status' },
  { command: 'clear', description: 'Clear the Telegram session routing' },
];

export interface TelegramAdapterOptions {
  token?: string;
  allowedUserIds: number[];
  logger: Logger;
}

type ReplyContext = Context & {
  chat?: { id: TelegramChatId };
  message?: TelegramMessage;
  from?: { id: number };
  api?: { deleteMessage(chatId: TelegramChatId, messageId: number): Promise<unknown> };
  reply(text: string, options?: ReplyOptions): Promise<unknown>;
};

type ReplyPayload = string | BridgeResponse;
type TelegramChatId = number | string;
type ReplyOptions = { parse_mode?: 'HTML'; reply_markup?: InlineKeyboard };

interface TelegramMessage {
  message_id?: number;
  chat?: { id?: TelegramChatId };
  text?: string;
  from?: { id: number };
}

type CallbackQueryContext = ReplyContext & {
  callbackQuery: { id: string; data?: string; from: { id: number }; message?: TelegramMessage };
  answerCallbackQuery(options?: { text?: string; show_alert?: boolean }): Promise<unknown>;
};

interface TelegramMessageRef {
  chatId: TelegramChatId;
  messageId: number;
}

interface TelegramUserSession {
  activeTarget?: BridgeTarget;
  activeLabel?: string;
  nextToken: number;
  tokens: Map<string, CallbackTarget>;
  cleanupMessages: TelegramMessageRef[];
}

type CallbackTarget =
  | { type: 'workspace'; workspaceName: string }
  | { type: 'thread'; workspaceName: string; threadTitle: string }
  | { type: 'new'; workspaceName: string }
  | { type: 'back' };

type InlineQueryContext = Context & {
  inlineQuery: { id: string; query: string; from: { id: number }; offset?: string };
  answerInlineQuery(results: InlineQueryResultArticle[], options?: { cache_time?: number; is_personal?: boolean }): Promise<unknown>;
};

export function createTelegramBot(bridge: TextBridge, options: TelegramAdapterOptions): Bot | undefined {
  if (!options.token) return undefined;
  if (options.allowedUserIds.length === 0) {
    throw new Error('TELEGRAM_ALLOWED_USER_IDS must contain at least one valid user ID when TELEGRAM_BOT_TOKEN is set.');
  }
  const bot = new Bot(options.token);
  registerTelegramHandlers(bot, bridge, options);
  void bot.api.setMyCommands(TELEGRAM_COMMANDS).catch((error: unknown) => {
    options.logger.warn('Could not register Telegram command menu', { error: error instanceof Error ? error.message : String(error) });
  });
  return bot;
}

export function registerTelegramHandlers(bot: Pick<Bot, 'command' | 'on'>, bridge: TextBridge, options: TelegramAdapterOptions): void {
  const sessions = new Map<number, TelegramUserSession>();

  bot.command('start', async (ctx) => {
    const typed = ctx as ReplyContext;
    if (!isAllowed(typed, options.allowedUserIds)) {
      const userId = getUserId(typed);
      options.logger.warn('Denied Telegram /start', { userId });
      return typed.reply(`Access denied. Your Telegram user id is ${userId ?? 'unknown'}.`);
    }
    return typed.reply('Codex bridge bot ready. Send text to forward it to Codex Desktop.');
  });

  bot.command('stop', async (ctx) => runAuthorized(ctx as ReplyContext, options, () => bridge.stopOrPause()));
  bot.command('new', async (ctx) => {
    const typed = ctx as ReplyContext;
    if (!isAllowed(typed, options.allowedUserIds)) return typed.reply('Access denied.');
    const userId = getUserId(typed);
    if (typeof userId !== 'number') return typed.reply('Access denied.');
    const session = getSession(sessions, userId);
    trackContextMessage(session, typed);
    return runMenuSafely(typed, options.logger, async () => {
      const workspaceName = session.activeTarget?.workspaceName ?? 'Chats';
      await bridge.openThread({ workspaceName, newThread: true });
      session.activeTarget = { workspaceName };
      session.activeLabel = `${workspaceName}: New`;
      await cleanupTelegramMessages(typed, session, options.logger);
    });
  });
  bot.command('status', async (ctx) => {
    const typed = ctx as ReplyContext;
    if (!isAllowed(typed, options.allowedUserIds)) return typed.reply('Access denied.');
    const userId = getUserId(typed);
    const session = typeof userId === 'number' ? getSession(sessions, userId) : undefined;
    const selected = session?.activeLabel ?? 'Chats: not selected';
    return runSafely(typed, options.logger, async () => [
      `Telegram route: ${selected}`,
      await bridge.getWorkspace(),
    ].join('\n'));
  });
  bot.command('clear', async (ctx) => {
    const typed = ctx as ReplyContext;
    if (!isAllowed(typed, options.allowedUserIds)) return typed.reply('Access denied.');
    const userId = getUserId(typed);
    if (typeof userId !== 'number') return typed.reply('Access denied.');
    const session = getSession(sessions, userId);
    trackContextMessage(session, typed);
    session.activeTarget = undefined;
    session.activeLabel = undefined;
    session.tokens.clear();
    return runMenuSafely(typed, options.logger, async () => cleanupTelegramMessages(typed, session, options.logger));
  });
  bot.command('workspace', async (ctx) => {
    const typed = ctx as ReplyContext;
    if (!isAllowed(typed, options.allowedUserIds)) return typed.reply('Access denied.');
    const userId = getUserId(typed);
    if (typeof userId !== 'number') return typed.reply('Access denied.');
    const session = getSession(sessions, userId);
    trackContextMessage(session, typed);
    return runMenuSafely(typed, options.logger, async () => sendWorkspaceMenu(typed, bridge, session));
  });

  bot.on('callback_query:data', async (ctx) => {
    const typed = ctx as CallbackQueryContext;
    if (!isCallbackAllowed(typed, options.allowedUserIds)) {
      await typed.answerCallbackQuery({ text: 'Access denied.', show_alert: true });
      return;
    }

    const session = getSession(sessions, typed.callbackQuery.from.id);
    const target = consumeCallbackTarget(session, typed.callbackQuery.data);
    if (!target) {
      await typed.answerCallbackQuery({ text: 'Menu expired. Run /workspace again.', show_alert: true });
      return;
    }

    await runMenuSafely(typed, options.logger, async () => {
      await typed.answerCallbackQuery();
      trackCallbackMessage(session, typed);
      if (target.type === 'workspace') {
        await cleanupTelegramMessages(typed, session, options.logger);
        await sendThreadMenu(typed, bridge, session, target.workspaceName);
        return;
      }

      if (target.type === 'back') {
        await cleanupTelegramMessages(typed, session, options.logger);
        await sendWorkspaceMenu(typed, bridge, session);
        return;
      }

      if (target.type === 'new') {
        await bridge.openThread({ workspaceName: target.workspaceName, newThread: true });
        session.activeTarget = { workspaceName: target.workspaceName };
        session.activeLabel = `${target.workspaceName}: New`;
      } else {
        await bridge.openThread({ workspaceName: target.workspaceName, threadTitle: target.threadTitle });
        session.activeTarget = { workspaceName: target.workspaceName, threadTitle: target.threadTitle };
        session.activeLabel = `${target.workspaceName}: ${target.threadTitle}`;
      }

      session.tokens.clear();
      await cleanupTelegramMessages(typed, session, options.logger);
    });
  });

  bot.on('inline_query', async (ctx) => {
    const typed = ctx as InlineQueryContext;
    if (!isInlineAllowed(typed, options.allowedUserIds)) {
      await typed.answerInlineQuery([], { cache_time: 1, is_personal: true });
      return;
    }

    const query = typed.inlineQuery.query.trim();
    const title = query ? `Forward to Codex: ${query.slice(0, 40)}` : 'Type a Codex prompt';
    const description = query || 'Inline mode forwards the selected text to Codex.';
    const results: InlineQueryResultArticle[] = [{
      type: 'article',
      id: `codex-${Buffer.from(query || 'empty').toString('base64url').slice(0, 32)}`,
      title,
      description,
      input_message_content: { message_text: query || 'Open Codex bridge chat and send a prompt.' },
    }];
    await typed.answerInlineQuery(results, { cache_time: 1, is_personal: true });
  });

  bot.on('message:text', async (ctx) => {
    const typed = ctx as ReplyContext;
    if (!isAllowed(typed, options.allowedUserIds)) return typed.reply('Access denied.');
    const text = typed.message?.text?.trim();
    if (!text || text.startsWith('/')) return;
    const userId = getUserId(typed);
    const session = typeof userId === 'number' ? getSession(sessions, userId) : undefined;
    if (session) trackContextMessage(session, typed);
    return runSafely(typed, options.logger, async () => {
      return bridge.handleText({ text, source: 'telegram', userId, target: session?.activeTarget });
    }, session);
  });
}

async function runAuthorized(ctx: ReplyContext, options: TelegramAdapterOptions, action: () => Promise<string>): Promise<unknown> {
  if (!isAllowed(ctx, options.allowedUserIds)) return ctx.reply('Access denied.');
  return runSafely(ctx, options.logger, action);
}

async function runSafely(ctx: ReplyContext, logger: Logger, action: () => Promise<ReplyPayload>, session?: TelegramUserSession): Promise<unknown> {
  try {
    return replyLongText(ctx, await action(), logger, session);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Telegram handler failed', { error: message });
    const sent = await ctx.reply(`Codex bridge error: ${message}`);
    if (session) trackReplyMessage(session, sent);
    return sent;
  }
}

async function runMenuSafely(ctx: ReplyContext, logger: Logger, action: () => Promise<void>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Telegram menu failed', { error: message });
    return ctx.reply(`Codex bridge error: ${message}`);
  }
  return undefined;
}

function isAllowed(ctx: ReplyContext, allowedUserIds: number[]): boolean {
  const userId = getUserId(ctx);
  return typeof userId === 'number' && allowedUserIds.includes(userId);
}

function isInlineAllowed(ctx: InlineQueryContext, allowedUserIds: number[]): boolean {
  return allowedUserIds.includes(ctx.inlineQuery.from.id);
}

function isCallbackAllowed(ctx: CallbackQueryContext, allowedUserIds: number[]): boolean {
  return allowedUserIds.includes(ctx.callbackQuery.from.id);
}

async function sendWorkspaceMenu(ctx: ReplyContext, bridge: TextBridge, session: TelegramUserSession): Promise<void> {
  const workspaces = await bridge.listWorkspaces();
  session.tokens.clear();
  const keyboard = new InlineKeyboard();
  for (const workspace of ensureChatsWorkspace(workspaces)) {
    keyboard.text(workspace.active ? `> ${workspace.name}` : workspace.name, createCallbackToken(session, { type: 'workspace', workspaceName: workspace.name })).row();
  }
  const sent = await ctx.reply('Select Codex workspace:', { reply_markup: keyboard });
  trackReplyMessage(session, sent);
}

async function sendThreadMenu(ctx: ReplyContext, bridge: TextBridge, session: TelegramUserSession, workspaceName: string): Promise<void> {
  const threads = await bridge.listThreads(workspaceName);
  session.tokens.clear();
  const keyboard = new InlineKeyboard()
    .text('+ New', createCallbackToken(session, { type: 'new', workspaceName }))
    .row();
  for (const thread of threads) {
    keyboard.text(formatThreadLabel(thread), createCallbackToken(session, { type: 'thread', workspaceName, threadTitle: thread.title })).row();
  }
  keyboard.text('Back', createCallbackToken(session, { type: 'back' }));
  const sent = await ctx.reply(`Workspace: ${workspaceName}\nSelect a thread:`, { reply_markup: keyboard });
  trackReplyMessage(session, sent);
}

async function replyLongText(ctx: ReplyContext, payload: ReplyPayload, logger: Logger, session?: TelegramUserSession): Promise<void> {
  const text = typeof payload === 'string' ? payload : payload.text;
  const html = typeof payload === 'string' || payload.format !== 'html' ? undefined : payload.formattedText?.trim();
  const htmlChunks = html ? splitTelegramHtml(html) : undefined;

  if (htmlChunks) {
    let sentCount = 0;
    try {
      for (const chunk of htmlChunks) {
        const reply = await ctx.reply(chunk, { parse_mode: 'HTML' });
        if (session) trackReplyMessage(session, reply);
        sentCount += 1;
      }
      return;
    } catch (error) {
      logger.warn('Formatted Telegram reply failed; falling back to plain text', { error: error instanceof Error ? error.message : String(error) });
      if (sentCount > 0) throw error;
    }
  }

  for (const chunk of splitTelegramText(text)) {
    const sent = await ctx.reply(chunk);
    if (session) trackReplyMessage(session, sent);
  }
}

function splitTelegramHtml(html: string, maxLength = MAX_TELEGRAM_MESSAGE_LENGTH): string[] | undefined {
  const source = html.trim();
  if (!source) return undefined;
  if (source.length <= maxLength) return [source];
  if (source.includes('<pre>')) return undefined;

  const chunks: string[] = [];
  let current = '';
  for (const block of source.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)) {
    if (block.length > maxLength) return undefined;
    const next = current ? `${current}\n\n${block}` : block;
    if (next.length > maxLength) {
      if (current) chunks.push(current);
      current = block;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : undefined;
}

export function splitTelegramText(text: string, maxLength = MAX_TELEGRAM_MESSAGE_LENGTH): string[] {
  const source = text.trim() || '(empty response)';
  const chunks: string[] = [];
  let remaining = source;

  while (remaining.length > maxLength) {
    const newlineIndex = remaining.lastIndexOf('\n', maxLength);
    const splitAt = newlineIndex > Math.floor(maxLength * 0.5) ? newlineIndex + 1 : maxLength;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  chunks.push(remaining);
  return chunks;
}

function ensureChatsWorkspace(workspaces: WorkspaceOption[]): WorkspaceOption[] {
  const hasChats = workspaces.some((workspace) => workspace.name.toLowerCase() === 'chats');
  return hasChats ? workspaces : [{ name: 'Chats' }, ...workspaces];
}

function formatThreadLabel(thread: ThreadOption): string {
  const title = thread.title.length > 64 ? `${thread.title.slice(0, 61)}...` : thread.title;
  return thread.active ? `> ${title}` : title;
}

function getSession(sessions: Map<number, TelegramUserSession>, userId: number): TelegramUserSession {
  let session = sessions.get(userId);
  if (!session) {
    session = { nextToken: 0, tokens: new Map(), cleanupMessages: [] };
    sessions.set(userId, session);
  }
  return session;
}

function createCallbackToken(session: TelegramUserSession, target: CallbackTarget): string {
  const token = (session.nextToken += 1).toString(36);
  session.tokens.set(token, target);
  return `cb:${token}`;
}

function consumeCallbackTarget(session: TelegramUserSession, data: string | undefined): CallbackTarget | undefined {
  const token = data?.match(/^cb:([a-z0-9]+)$/i)?.[1];
  if (!token) return undefined;
  return session.tokens.get(token);
}

function trackContextMessage(session: TelegramUserSession, ctx: ReplyContext): void {
  trackMessage(session, ctx.message, ctx.chat?.id);
}

function trackCallbackMessage(session: TelegramUserSession, ctx: CallbackQueryContext): void {
  trackMessage(session, ctx.callbackQuery.message, ctx.chat?.id);
}

function trackReplyMessage(session: TelegramUserSession, result: unknown): void {
  trackMessage(session, result as TelegramMessage | undefined);
}

function trackMessage(session: TelegramUserSession, message: TelegramMessage | undefined, fallbackChatId?: TelegramChatId): void {
  const messageId = message?.message_id;
  const chatId = message?.chat?.id ?? fallbackChatId;
  if (typeof messageId !== 'number' || typeof chatId === 'undefined') return;
  if (session.cleanupMessages.some((item) => item.chatId === chatId && item.messageId === messageId)) return;
  session.cleanupMessages.push({ chatId, messageId });
}

async function cleanupTelegramMessages(ctx: ReplyContext, session: TelegramUserSession, logger: Logger): Promise<void> {
  const refs = session.cleanupMessages.splice(0);
  session.tokens.clear();
  for (const ref of refs) {
    await ctx.api?.deleteMessage(ref.chatId, ref.messageId).catch((error: unknown) => {
      logger.debug('Could not delete Telegram history message', { messageId: ref.messageId, error: error instanceof Error ? error.message : String(error) });
    });
  }
}

function getUserId(ctx: ReplyContext): number | undefined {
  return ctx.from?.id ?? ctx.message?.from?.id;
}
