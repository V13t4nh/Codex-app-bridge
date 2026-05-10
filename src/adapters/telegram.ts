import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { InlineQueryResultArticle } from '@grammyjs/types';
import type { BridgeResponse, BridgeTarget, TextBridge, ThreadOption, WorkspaceOption } from '../core/types.js';
import type { Logger } from '../logger.js';

const MAX_TELEGRAM_MESSAGE_LENGTH = 3_900;
const MAX_TELEGRAM_BUTTON_LABEL_LENGTH = 64;
const MAX_TELEGRAM_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TELEGRAM_BOT_COMMANDS = 100;
const TELEGRAM_CLEAR_ALL_SCAN_LIMIT = 500;
const TELEGRAM_CLEAR_ALL_STOP_ERROR_PATTERNS = [
  /message can't be deleted/i,
];
export const TELEGRAM_MESSAGE_COALESCE_MS = 1_000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const THINKING_UPDATE_MS = 4_000;
const THINKING_FRAMES = ['🤔 Codex đang nghĩ...', '💭 Codex đang nghĩ...', '⏳ Codex đang nghĩ...'];
const TELEGRAM_FILE_STORAGE_DIR = join(process.cwd(), '.omc', 'telegram-files');

export const TELEGRAM_COMMANDS = [
  { command: 'workspace', description: 'Choose Codex workspace and thread' },
  { command: 'stop', description: 'Stop the active Codex response' },
  { command: 'status', description: 'Show current routing and Codex workspace status' },
  { command: 'clear', description: 'Clear the Telegram session routing' },
  { command: 'clear_all', description: 'Reset and delete recent bot chat messages' },
];

export interface TelegramAdapterOptions {
  token?: string;
  allowedUserIds: number[];
  logger: Logger;
  skillCommands?: TelegramSkillCommand[];
}

export interface TelegramSkillCommand {
  command: string;
  skillName: string;
  description: string;
}

type ReplyContext = Context & {
  chat?: { id: TelegramChatId };
  message?: TelegramMessage;
  from?: { id: number };
  api?: {
    deleteMessage(chatId: TelegramChatId, messageId: number): Promise<unknown>;
    deleteMessages?(chatId: TelegramChatId, messageIds: number[]): Promise<unknown>;
    editMessageText?(chatId: TelegramChatId, messageId: number, text: string): Promise<unknown>;
    getFile?(fileId: string): Promise<TelegramFile>;
    sendChatAction?(chatId: TelegramChatId, action: 'typing'): Promise<unknown>;
  };
  reply(text: string, options?: ReplyOptions): Promise<unknown>;
};

type ReplyPayload = string | BridgeResponse;
type TelegramChatId = number | string;
type ReplyOptions = { parse_mode?: 'HTML'; reply_markup?: InlineKeyboard };

interface TelegramMessage {
  message_id?: number;
  chat?: { id?: TelegramChatId };
  text?: string;
  caption?: string;
  document?: TelegramDocument;
  from?: { id: number };
}

interface TelegramDocument {
  file_id: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
}

interface TelegramFile {
  file_path?: string;
  file_size?: number;
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
  lastSeenAt: number;
  nextToken: number;
  tokens: Map<string, CallbackTarget>;
  cleanupMessages: TelegramMessageRef[];
  pendingPrompt?: PendingTelegramPrompt;
}

interface PendingTelegramPrompt {
  ctx: ReplyContext;
  texts: string[];
  userId?: number;
  target?: BridgeTarget;
  timer?: ReturnType<typeof setTimeout>;
}

interface ThinkingIndicator {
  stop(): Promise<void>;
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
  const skillCommands = options.skillCommands ?? discoverTelegramSkillCommands(options.logger);
  const botOptions = { ...options, skillCommands };
  const bot = new Bot(options.token);
  registerTelegramHandlers(bot, bridge, botOptions);
  void bot.api.setMyCommands(buildTelegramCommands(skillCommands)).catch((error: unknown) => {
    options.logger.warn('Could not register Telegram command menu', { error: error instanceof Error ? error.message : String(error) });
  });
  return bot;
}

export function buildTelegramCommands(skillCommands: TelegramSkillCommand[] = []): Array<{ command: string; description: string }> {
  const remaining = Math.max(0, MAX_TELEGRAM_BOT_COMMANDS - TELEGRAM_COMMANDS.length);
  return [
    ...TELEGRAM_COMMANDS,
    ...skillCommands.slice(0, remaining).map(({ command, description }) => ({ command, description })),
  ];
}

export function discoverTelegramSkillCommands(logger?: Logger): TelegramSkillCommand[] {
  const commands = new Map<string, TelegramSkillCommand>();
  const skillNames = discoverLocalSkillNames(logger);
  for (const skillName of skillNames) {
    const command = skillNameToTelegramCommand(skillName);
    if (!command || TELEGRAM_COMMANDS.some((item) => item.command === command) || commands.has(command)) continue;
    commands.set(command, {
      command,
      skillName,
      description: `Run $${skillName}`,
    });
  }
  return Array.from(commands.values())
    .sort((left, right) => left.command.localeCompare(right.command))
    .slice(0, Math.max(0, MAX_TELEGRAM_BOT_COMMANDS - TELEGRAM_COMMANDS.length));
}

export function registerTelegramHandlers(bot: Pick<Bot, 'command' | 'on'>, bridge: TextBridge, options: TelegramAdapterOptions): void {
  const sessions = new Map<number, TelegramUserSession>();
  const skillCommands = options.skillCommands ?? [];

  bot.command('start', async (ctx) => {
    const typed = ctx as ReplyContext;
    if (!isAllowed(typed, options.allowedUserIds)) {
      const userId = getUserId(typed);
      options.logger.warn('Denied Telegram /start', { userId });
      return typed.reply(`Access denied. Your Telegram user id is ${userId ?? 'unknown'}.`);
    }
    const userId = getUserId(typed);
    if (typeof userId === 'number') {
      const session = getSession(sessions, userId);
      resetTelegramSession(session);
    }
    return typed.reply('Codex bridge bot ready. Send text to forward it to Codex Desktop.');
  });

  bot.command('stop', async (ctx) => runAuthorized(ctx as ReplyContext, options, () => bridge.stopOrPause()));
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
    if (isClearAllCommandText(typed.message?.text)) {
      return runMenuSafely(typed, options.logger, async () => {
        resetTelegramSession(session);
        await cleanupAllTelegramMessages(typed, session, options.logger);
        sessions.delete(userId);
      });
    }
    resetTelegramSession(session);
    return runMenuSafely(typed, options.logger, async () => cleanupTelegramMessages(typed, session, options.logger));
  });
  bot.command(['clear_all', 'clearall'], async (ctx) => {
    const typed = ctx as ReplyContext;
    if (!isAllowed(typed, options.allowedUserIds)) return typed.reply('Access denied.');
    const userId = getUserId(typed);
    if (typeof userId !== 'number') return typed.reply('Access denied.');
    const session = getSession(sessions, userId);
    trackContextMessage(session, typed);
    return runMenuSafely(typed, options.logger, async () => {
      resetTelegramSession(session);
      await cleanupAllTelegramMessages(typed, session, options.logger);
      sessions.delete(userId);
    });
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

  for (const skillCommand of skillCommands) {
    bot.command(skillCommand.command, async (ctx) => {
      const typed = ctx as ReplyContext;
      if (!isAllowed(typed, options.allowedUserIds)) return typed.reply('Access denied.');
      const text = buildSkillPrompt(skillCommand, typed.message?.text);
      const userId = getUserId(typed);
      const session = typeof userId === 'number' ? getSession(sessions, userId) : undefined;
      if (session) trackContextMessage(session, typed);
      return runSafely(
        typed,
        options.logger,
        async () => bridge.handleText({ text, source: 'telegram', userId, target: session?.activeTarget }),
        session,
        { thinking: true },
      );
    });
  }

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
        await bridge.openThread({ workspaceName: target.workspaceName });
        session.activeTarget = { workspaceName: target.workspaceName };
        session.activeLabel = `${target.workspaceName}: Current`;
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
    const text = normalizeTelegramPrompt(typed.message?.text);
    if (!text || text.startsWith('/')) return;
    const userId = getUserId(typed);
    const session = typeof userId === 'number' ? getSession(sessions, userId) : undefined;
    if (session) trackContextMessage(session, typed);
    if (session) {
      queueTelegramPrompt(typed, bridge, options.logger, session, { text, userId, target: session.activeTarget });
      return;
    }
    return runSafely(typed, options.logger, async () => bridge.handleText({ text, source: 'telegram', userId }), undefined, { thinking: true });
  });

  bot.on('message:document', async (ctx) => {
    const typed = ctx as ReplyContext;
    if (!isAllowed(typed, options.allowedUserIds)) return typed.reply('Access denied.');
    const userId = getUserId(typed);
    const session = typeof userId === 'number' ? getSession(sessions, userId) : undefined;
    if (session) trackContextMessage(session, typed);
    return runSafely(
      typed,
      options.logger,
      async () => {
        const prompt = await prepareTelegramDocumentPrompt(typed, options.token);
        return bridge.handleText({ text: prompt, source: 'telegram', userId, target: session?.activeTarget });
      },
      session,
      { thinking: true },
    );
  });
}

async function runAuthorized(ctx: ReplyContext, options: TelegramAdapterOptions, action: () => Promise<string>): Promise<unknown> {
  if (!isAllowed(ctx, options.allowedUserIds)) return ctx.reply('Access denied.');
  return runSafely(ctx, options.logger, action);
}

async function runSafely(
  ctx: ReplyContext,
  logger: Logger,
  action: () => Promise<ReplyPayload>,
  session?: TelegramUserSession,
  options: { thinking?: boolean } = {},
): Promise<unknown> {
  const thinking = options.thinking ? await startThinkingIndicator(ctx, logger, session) : undefined;
  try {
    const payload = await action();
    await thinking?.stop();
    return replyLongText(ctx, payload, logger, session);
  } catch (error) {
    await thinking?.stop();
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Telegram handler failed', { error: message });
    const sent = await ctx.reply(`Codex bridge error: ${message}`);
    if (session) trackReplyMessage(session, sent);
    return sent;
  }
}

function queueTelegramPrompt(
  ctx: ReplyContext,
  bridge: TextBridge,
  logger: Logger,
  session: TelegramUserSession,
  request: { text: string; userId?: number; target?: BridgeTarget },
): void {
  const pending = session.pendingPrompt;
  if (pending) {
    pending.ctx = ctx;
    pending.texts.push(request.text);
    pending.userId = request.userId;
    pending.target = cloneTarget(request.target);
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = scheduleTelegramPromptFlush(bridge, logger, session);
    return;
  }

  session.pendingPrompt = {
    ctx,
    texts: [request.text],
    userId: request.userId,
    target: cloneTarget(request.target),
    timer: scheduleTelegramPromptFlush(bridge, logger, session),
  };
}

function scheduleTelegramPromptFlush(bridge: TextBridge, logger: Logger, session: TelegramUserSession): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    void flushTelegramPrompt(bridge, logger, session).catch((error: unknown) => {
      logger.error('Queued Telegram prompt failed', { error: error instanceof Error ? error.message : String(error) });
    });
  }, TELEGRAM_MESSAGE_COALESCE_MS);
}

async function flushTelegramPrompt(bridge: TextBridge, logger: Logger, session: TelegramUserSession): Promise<void> {
  const pending = session.pendingPrompt;
  if (!pending) return;
  session.pendingPrompt = undefined;
  if (pending.timer) clearTimeout(pending.timer);

  const text = pending.texts.join('\n').trim();
  if (!text) return;

  await runSafely(
    pending.ctx,
    logger,
    async () => bridge.handleText({ text, source: 'telegram', userId: pending.userId, target: pending.target }),
    session,
    { thinking: true },
  );
}

async function startThinkingIndicator(ctx: ReplyContext, logger: Logger, session?: TelegramUserSession): Promise<ThinkingIndicator | undefined> {
  const sent = await ctx.reply(THINKING_FRAMES[0]).catch((error: unknown) => {
    logger.debug('Could not send Telegram thinking indicator', { error: error instanceof Error ? error.message : String(error) });
    return undefined;
  });
  if (!sent) return undefined;

  if (session) trackReplyMessage(session, sent);
  const ref = messageRefFrom(sent as TelegramMessage | undefined, ctx.chat?.id);
  if (!ref) return { stop: async () => undefined };

  let frameIndex = 0;
  const timer = ctx.api?.editMessageText
    ? setInterval(() => {
      frameIndex = (frameIndex + 1) % THINKING_FRAMES.length;
      void ctx.api?.sendChatAction?.(ref.chatId, 'typing')?.catch(() => undefined);
      void ctx.api?.editMessageText?.(ref.chatId, ref.messageId, THINKING_FRAMES[frameIndex] ?? THINKING_FRAMES[0])?.catch((error: unknown) => {
        logger.debug('Could not update Telegram thinking indicator', { error: error instanceof Error ? error.message : String(error) });
      });
    }, THINKING_UPDATE_MS)
    : undefined;

  return {
    stop: async () => {
      if (timer) clearInterval(timer);
      await ctx.api?.deleteMessage(ref.chatId, ref.messageId).catch((error: unknown) => {
        logger.debug('Could not delete Telegram thinking indicator', { messageId: ref.messageId, error: error instanceof Error ? error.message : String(error) });
      });
    },
  };
}

async function prepareTelegramDocumentPrompt(ctx: ReplyContext, token: string | undefined): Promise<string> {
  const document = ctx.message?.document;
  if (!document) throw new Error('Telegram document payload is missing.');
  if (!token) throw new Error('Telegram document download requires TELEGRAM_BOT_TOKEN.');

  const declaredSize = document.file_size;
  if (typeof declaredSize === 'number' && declaredSize > MAX_TELEGRAM_FILE_BYTES) {
    throw new Error(`Telegram document is too large (${declaredSize} bytes). Max supported size is ${MAX_TELEGRAM_FILE_BYTES} bytes.`);
  }

  const file = await ctx.api?.getFile?.(document.file_id);
  if (!file?.file_path) throw new Error('Telegram did not return a downloadable file path.');
  if (typeof file.file_size === 'number' && file.file_size > MAX_TELEGRAM_FILE_BYTES) {
    throw new Error(`Telegram document is too large (${file.file_size} bytes). Max supported size is ${MAX_TELEGRAM_FILE_BYTES} bytes.`);
  }

  const fileName = sanitizeTelegramFileName(document.file_name ?? basename(file.file_path));
  const userId = getUserId(ctx) ?? 'unknown';
  const messageId = ctx.message?.message_id ?? Date.now();
  const localDir = join(TELEGRAM_FILE_STORAGE_DIR, String(userId));
  const localPath = join(localDir, `${messageId}-${fileName}`);
  await mkdir(localDir, { recursive: true });

  const encodedFilePath = file.file_path.split('/').map((part) => encodeURIComponent(part)).join('/');
  const url = `https://api.telegram.org/file/bot${token}/${encodedFilePath}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status} ${response.statusText}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.byteLength > MAX_TELEGRAM_FILE_BYTES) {
    throw new Error(`Telegram document is too large (${data.byteLength} bytes). Max supported size is ${MAX_TELEGRAM_FILE_BYTES} bytes.`);
  }
  await writeFile(localPath, data);

  const caption = normalizeTelegramPrompt(ctx.message?.caption);
  return [
    `Telegram document received: ${fileName}`,
    `Local path: ${localPath}`,
    `MIME type: ${document.mime_type ?? 'unknown'}`,
    `Size: ${data.byteLength} bytes`,
    caption ? `Caption:\n${caption}` : 'Caption: none',
    'Use the local file path as context for this request.',
  ].join('\n');
}

function buildSkillPrompt(skillCommand: TelegramSkillCommand, text: string | undefined): string {
  const args = text
    ?.replace(/^\/[a-z0-9_]+(?:@\w+)?/i, '')
    .trim();
  return args ? `$${skillCommand.skillName} ${args}` : `$${skillCommand.skillName}`;
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
  for (const workspace of ensureWorkspaceMenuOptions(workspaces)) {
    keyboard.text(formatWorkspaceLabel(workspace), createCallbackToken(session, { type: 'workspace', workspaceName: workspace.name })).row();
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

function normalizeTelegramPrompt(text: string | undefined): string | undefined {
  const normalized = text?.replace(/\r\n/g, '\n').trim();
  return normalized || undefined;
}

function sanitizeTelegramFileName(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized.slice(0, 120) || 'telegram-file';
}

function discoverLocalSkillNames(logger?: Logger): string[] {
  const roots = [
    process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'skills') : undefined,
    process.env.USERPROFILE ? join(process.env.USERPROFILE, '.codex', 'skills') : undefined,
    process.env.USERPROFILE ? join(process.env.USERPROFILE, '.agents', 'skills') : undefined,
  ].filter((value): value is string => Boolean(value));
  const seen = new Set<string>();
  const result: string[] = [];

  for (const root of roots) {
    for (const skillName of readSkillNamesFromRoot(root, logger)) {
      const key = skillName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(skillName);
    }
  }

  return result;
}

function readSkillNamesFromRoot(root: string, logger?: Logger): string[] {
  try {
    if (!existsSync(root)) return [];
    const entries = readdirSync(root, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = join(root, entry.name);
      if (entry.name === '.system') {
        names.push(...readSkillNamesFromRoot(fullPath, logger));
        continue;
      }
      if (entry.name.startsWith('.')) continue;
      if (!existsSync(join(fullPath, 'SKILL.md'))) continue;
      names.push(entry.name);
    }
    return names;
  } catch (error) {
    logger?.debug('Could not discover Telegram skill commands', { root, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

function skillNameToTelegramCommand(skillName: string): string | undefined {
  const command = skillName
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return /^[a-z0-9_]{1,32}$/.test(command) ? command : undefined;
}

function cloneTarget(target: BridgeTarget | undefined): BridgeTarget | undefined {
  return target ? { ...target } : undefined;
}

function resetTelegramSession(session: TelegramUserSession): void {
  session.activeTarget = undefined;
  session.activeLabel = undefined;
  cancelPendingPrompt(session);
  session.tokens.clear();
}

function cancelPendingPrompt(session: TelegramUserSession): void {
  if (session.pendingPrompt?.timer) clearTimeout(session.pendingPrompt.timer);
  session.pendingPrompt = undefined;
}

function messageRefFrom(message: TelegramMessage | undefined, fallbackChatId?: TelegramChatId): TelegramMessageRef | undefined {
  const messageId = message?.message_id;
  const chatId = message?.chat?.id ?? fallbackChatId;
  if (typeof messageId !== 'number' || typeof chatId === 'undefined') return undefined;
  return { chatId, messageId };
}

function ensureWorkspaceMenuOptions(workspaces: WorkspaceOption[]): WorkspaceOption[] {
  return workspaces.length > 0 ? workspaces : [{ name: 'Chats' }];
}

function formatWorkspaceLabel(workspace: WorkspaceOption): string {
  const prefix = workspace.active ? '> ' : '';
  return `${prefix}${truncateTelegramButtonLabel(workspace.name, MAX_TELEGRAM_BUTTON_LABEL_LENGTH - prefix.length)}`;
}

function formatThreadLabel(thread: ThreadOption): string {
  const title = truncateTelegramButtonLabel(thread.title, MAX_TELEGRAM_BUTTON_LABEL_LENGTH);
  return thread.active ? `> ${title}` : title;
}

function truncateTelegramButtonLabel(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function getSession(sessions: Map<number, TelegramUserSession>, userId: number): TelegramUserSession {
  const now = Date.now();
  pruneExpiredSessions(sessions, now);
  let session = sessions.get(userId);
  if (!session) {
    session = { lastSeenAt: now, nextToken: 0, tokens: new Map(), cleanupMessages: [] };
    sessions.set(userId, session);
  }
  session.lastSeenAt = now;
  return session;
}

function pruneExpiredSessions(sessions: Map<number, TelegramUserSession>, now: number): void {
  for (const [userId, session] of sessions) {
    if (now - session.lastSeenAt > SESSION_TTL_MS) sessions.delete(userId);
  }
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

async function cleanupAllTelegramMessages(ctx: ReplyContext, session: TelegramUserSession, logger: Logger): Promise<void> {
  const refs = collectClearAllMessageRefs(ctx, session);
  session.cleanupMessages = [];
  session.tokens.clear();
  let deleted = 0;
  const skipped = new Map<string, number>();
  for (const ref of refs) {
    const result = await deleteTelegramMessage(ctx, ref);
    const didDelete = result === 'deleted';
    if (didDelete) deleted += 1;
    if (result !== 'deleted') {
      skipped.set(result, (skipped.get(result) ?? 0) + 1);
      if (shouldStopClearAllScan(result)) break;
    }
  }
  logger.info('Telegram clear-all completed', { attempted: refs.length, deleted, skipped: Object.fromEntries(skipped) });
}

async function deleteTelegramMessage(ctx: ReplyContext, ref: TelegramMessageRef): Promise<'deleted' | string> {
  try {
    await ctx.api?.deleteMessage(ref.chatId, ref.messageId);
    return 'deleted';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function shouldStopClearAllScan(error: string): boolean {
  return TELEGRAM_CLEAR_ALL_STOP_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

function collectClearAllMessageRefs(ctx: ReplyContext, session: TelegramUserSession): TelegramMessageRef[] {
  const refs = [...session.cleanupMessages];
  const current = messageRefFrom(ctx.message, ctx.chat?.id);
  if (current) {
    const firstMessageId = Math.max(1, current.messageId - TELEGRAM_CLEAR_ALL_SCAN_LIMIT + 1);
    for (let messageId = current.messageId; messageId >= firstMessageId; messageId -= 1) {
      refs.push({ chatId: current.chatId, messageId });
    }
  }
  return dedupeMessageRefs(refs);
}

function dedupeMessageRefs(refs: TelegramMessageRef[]): TelegramMessageRef[] {
  const seen = new Set<string>();
  const result: TelegramMessageRef[] = [];
  for (const ref of refs) {
    const key = `${ref.chatId}:${ref.messageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function isClearAllCommandText(text: string | undefined): boolean {
  return /^\/clear(?:@\w+)?\s+all\b/i.test(text ?? '');
}

function getUserId(ctx: ReplyContext): number | undefined {
  return ctx.from?.id ?? ctx.message?.from?.id;
}
