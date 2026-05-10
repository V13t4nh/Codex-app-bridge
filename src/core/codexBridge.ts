import { chromium, type Browser, type Page } from 'playwright';
import type { Logger } from '../logger.js';
import {
  clickThreadControl as clickCodexThreadControl,
  clickWorkspaceControl as clickCodexWorkspaceControl,
  clickWorkspaceNewControl as clickCodexWorkspaceNewControl,
  detectThreadState as detectCodexThreadState,
  detectWorkspaceState as detectCodexWorkspaceState,
  isWorkspaceOpen as isCodexWorkspaceOpen,
  readRuntimeState as readCodexRuntimeState,
  type CodexRuntimeState,
} from './codexDom.js';
import { formatDomControl, getDomControls } from './domDiscovery.js';
import { firstVisible, firstVisibleEnabled, fillPrompt } from './playwrightHelpers.js';
import { readResponseSnapshot, selectNewResponse, snapshotSummary, type ResponseSnapshot, type SelectedResponse } from './responseExtraction.js';
import { INPUT_CANDIDATES, NEW_CHAT_CANDIDATES, RESPONSE_CANDIDATES, SEND_CANDIDATES, STOP_CANDIDATES } from './selectorConfig.js';
import type { BridgeRequest, BridgeResponse, BridgeTarget, ChatMode, DiscoveryResult, SelectorCandidate, TextBridge, ThreadOption, WorkspaceOption } from './types.js';

const RESPONSE_STABLE_AFTER_IDLE_MS = 5_000;
const IDLE_CONFIRMATION_MS = 1_500;

export interface CodexBridgeOptions {
  cdpUrl: string;
  timeoutMs: number;
  logger: Logger;
  workspaceName?: string;
  chatMode: ChatMode;
}

export class CodexBridge implements TextBridge {
  private browser?: Browser;
  private page?: Page;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private activeOperationAbort?: AbortController;
  private routedWorkspace?: string;
  private routedThread?: string;

  constructor(private readonly options: CodexBridgeOptions) {}

  async handleText(request: BridgeRequest): Promise<BridgeResponse> {
    return this.enqueue(() => this.handleTextUnsafe(request));
  }

  private async handleTextUnsafe(request: BridgeRequest): Promise<BridgeResponse> {
    const abort = new AbortController();
    this.activeOperationAbort = abort;
    const page = await this.getCodexPage();
    try {
      await this.waitUntilReadyForPrompt(page, abort.signal);
      await this.routeTarget(page, request.target);
      const before = await readResponseSnapshot(page);
      const input = await firstVisible(page, INPUT_CANDIDATES, 1_500);
      if (!input) throw new Error('Could not find Codex input box. Run npm run doctor for selector diagnostics.');

      this.options.logger.info('Using input selector', { selector: input.candidate.name, timeoutMs: this.options.timeoutMs, responseBefore: snapshotSummary(before) });
      await fillPrompt(input.locator, request.text);

      const send = await firstVisibleEnabled(page, SEND_CANDIDATES, 1_500);
      if (send) {
        this.options.logger.info('Using send selector', { selector: send.candidate.name });
        await send.locator.click();
      } else {
        this.options.logger.warn('Enabled send button not found; trying keyboard submit fallbacks');
        await input.locator.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter').catch(() => undefined);
        await page.waitForTimeout(300);
        await input.locator.press('Enter').catch(() => undefined);
      }

      const response = await this.waitForNewResponse(page, before, request.text, abort.signal);
      const text = response.text;
      const title = await page.title().catch(() => undefined);
      const pageUrl = page.url();
      this.options.logger.info('Codex response received', { pageTitle: title, pageUrl, responseLength: text.length });

      return { text, formattedText: response.formattedText, format: response.format, metadata: { responseLength: text.length, pageTitle: title, pageUrl } };
    } finally {
      if (this.activeOperationAbort === abort) this.activeOperationAbort = undefined;
    }
  }

  async stopOrPause(): Promise<string> {
    const clicked = await this.clickFirst(STOP_CANDIDATES, 'stop/pause');
    this.activeOperationAbort?.abort();
    return clicked ? 'Stop/pause requested.' : 'Could not find a Stop/Pause button.';
  }

  async getWorkspace(): Promise<string> {
    return this.enqueue(async () => {
      const page = await this.getCodexPage();
      const title = await page.title().catch(() => 'unknown');
      const detected = await this.detectWorkspaceState(page);
      return [
        `Page: ${title} (${page.url()})`,
        `Target workspace: ${this.options.workspaceName ?? 'unset'}`,
        `Routed workspace: ${this.routedWorkspace ?? 'not yet routed'}`,
        `Routed thread: ${this.routedThread ?? 'not selected'}`,
        `Detected workspaces: ${detected.workspaces.length ? detected.workspaces.join(', ') : 'not detected'}`,
      ].join('\n');
    });
  }

  async listWorkspaces(): Promise<WorkspaceOption[]> {
    return this.enqueue(async () => {
      const page = await this.getCodexPage();
      const detected = await this.detectWorkspaceState(page);
      const names = uniqueNames(detected.workspaces.length ? detected.workspaces : ['Chats']);
      return names.map((name) => ({ name, active: namesEqual(name, detected.activeWorkspace) || namesEqual(name, this.routedWorkspace) }));
    });
  }

  async listThreads(workspaceName: string): Promise<ThreadOption[]> {
    return this.enqueue(async () => {
      const page = await this.getCodexPage();
      await this.ensureWorkspace(page, workspaceName, 'current');
      await page.waitForTimeout(300);
      return this.detectThreadState(page, workspaceName);
    });
  }

  async openThread(target: BridgeTarget): Promise<string> {
    return this.enqueue(async () => {
      const page = await this.getCodexPage();
      await this.openThreadUnsafe(page, target);
      const workspace = target.workspaceName ?? this.options.workspaceName ?? 'current workspace';
      const thread = target.newThread ? 'new thread' : target.threadTitle ?? 'current thread';
      return `Selected ${workspace}: ${thread}.`;
    });
  }

  async discover(): Promise<DiscoveryResult> {
    const page = await this.getCodexPage();
    const pageTitle = await page.title().catch(() => 'unknown');
    const pageUrl = page.url();
    const input = await firstVisible(page, INPUT_CANDIDATES, 800);
    const send = await firstVisible(page, SEND_CANDIDATES, 800);
    const response = await firstVisible(page, RESPONSE_CANDIDATES, 800);
    const workspaceState = await this.detectWorkspaceState(page);
    const diagnostics = await this.inspectDom(page);
    return {
      pageTitle,
      pageUrl,
      targetWorkspace: this.options.workspaceName,
      chatMode: this.options.chatMode,
      activeWorkspace: this.routedWorkspace ?? workspaceState.activeWorkspace,
      inputSelector: input?.candidate,
      sendSelector: send?.candidate,
      responseSelector: response?.candidate,
      diagnostics,
    };
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
    this.page = undefined;
  }

  private async getCodexPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    this.browser ??= await chromium.connectOverCDP(this.options.cdpUrl);
    const pages = this.browser.contexts().flatMap((context) => context.pages());
    if (pages.length === 0) throw new Error(`Connected to ${this.options.cdpUrl}, but no Chromium pages are open.`);

    const scored = await Promise.all(pages.map(async (page) => {
      const title = await page.title().catch(() => '');
      const url = page.url();
      const score = /codex|openai|chat/i.test(`${title} ${url}`) ? 10 : 0;
      return { page, title, url, score };
    }));
    scored.sort((a, b) => b.score - a.score);
    const selected = scored[0];
    if (!selected || selected.score <= 0) {
      const openPages = scored.map((entry) => `${entry.title || '(untitled)'} ${entry.url}`).join('; ');
      throw new Error(`Could not positively identify a Codex page. Open pages: ${openPages}`);
    }
    this.page = selected.page;
    this.options.logger.info('Selected Codex page', { title: selected.title, url: selected.url });
    return this.page;
  }

  private async waitForNewResponse(page: Page, before: ResponseSnapshot, prompt: string, signal: AbortSignal): Promise<SelectedResponse> {
    const deadline = Date.now() + this.options.timeoutMs;
    let last: SelectedResponse | undefined;
    let lastChangedAt = 0;
    let lastSnapshot = before;
    let idleSince = 0;
    let lastState: CodexRuntimeState = { stopCount: 0, runningCount: 0, sendCount: 0, composerTextLength: 0 };

    while (Date.now() < deadline) {
      this.throwIfAborted(signal);
      const currentSnapshot = await readResponseSnapshot(page);
      const current = selectNewResponse(before, currentSnapshot, prompt);
      lastSnapshot = currentSnapshot;
      lastState = await readCodexRuntimeState(page);
      const busy = lastState.stopCount > 0 || lastState.runningCount > 0;

      if (current && current.text !== last?.text) {
        last = current;
        lastChangedAt = Date.now();
      }

      if (busy) {
        idleSince = 0;
      } else if (!idleSince) {
        idleSince = Date.now();
      }

      const stableForMs = last ? Date.now() - lastChangedAt : 0;
      const idleForMs = idleSince ? Date.now() - idleSince : 0;
      if (last && !busy && stableForMs >= RESPONSE_STABLE_AFTER_IDLE_MS && idleForMs >= IDLE_CONFIRMATION_MS) {
        return last;
      }

      await page.waitForTimeout(800);
    }
    throw new Error(`Timed out after ${this.options.timeoutMs}ms waiting for a completed Codex response. Last response length: ${last?.text.length ?? 0}. Snapshot: ${snapshotSummary(lastSnapshot)}. Runtime: stop=${lastState.stopCount}, running=${lastState.runningCount}, send=${lastState.sendCount}.`);
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.catch(() => undefined);
    return run;
  }

  private async clickFirst(candidates: SelectorCandidate[], label: string): Promise<boolean> {
    const page = await this.getCodexPage();
    const found = await firstVisible(page, candidates, 1_000);
    if (!found) {
      this.options.logger.warn(`No ${label} selector found`);
      return false;
    }
    this.options.logger.info(`Clicking ${label}`, { selector: found.candidate.name });
    await found.locator.click();
    return true;
  }

  private async inspectDom(page: Page): Promise<string[]> {
    const controls = await getDomControls(page);
    return controls.map(formatDomControl);
  }

  private async waitUntilReadyForPrompt(page: Page, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.options.timeoutMs;
    while (Date.now() < deadline) {
      this.throwIfAborted(signal);
      const state = await readCodexRuntimeState(page);
      if (state.stopCount === 0 && state.runningCount === 0) return;
      this.options.logger.info('Codex is busy; waiting before sending prompt', { stopCount: state.stopCount, runningCount: state.runningCount });
      await page.waitForTimeout(2_000);
    }
    throw new Error(`Timed out after ${this.options.timeoutMs}ms waiting for Codex to become ready for a new prompt.`);
  }

  private async routeTarget(page: Page, target: BridgeTarget | undefined): Promise<void> {
    const workspaceName = target?.workspaceName ?? this.options.workspaceName;
    await this.ensureWorkspace(page, workspaceName, target ? 'current' : this.options.chatMode);
    if (target?.newThread) {
      await this.openThreadUnsafe(page, { workspaceName, newThread: true });
      return;
    }
    if (target?.threadTitle) await this.openThreadUnsafe(page, { workspaceName, threadTitle: target.threadTitle });
  }

  private async openThreadUnsafe(page: Page, target: BridgeTarget): Promise<void> {
    const workspaceName = target.workspaceName ?? this.options.workspaceName;
    if (target.newThread) {
      const clicked = await this.clickNewThreadControl(page, workspaceName);
      if (!clicked) throw new Error(`Could not find a New Chat button for ${workspaceName ?? 'the current workspace'}.`);
      this.routedWorkspace = workspaceName;
      this.routedThread = undefined;
      await page.waitForTimeout(600);
      return;
    }

    await this.ensureWorkspace(page, workspaceName, 'current');
    if (!target.threadTitle) return;

    const clicked = await clickCodexThreadControl(page, target.threadTitle);
    if (!clicked) throw new Error(`Could not find Codex thread "${target.threadTitle}" in ${workspaceName ?? 'the current workspace'}.`);
    this.routedThread = target.threadTitle;
    await page.waitForTimeout(600);
  }

  private async ensureWorkspace(page: Page, workspaceName = this.options.workspaceName, mode: ChatMode = this.options.chatMode): Promise<void> {
    if (!workspaceName) return;
    if (mode === 'current' && namesEqual(workspaceName, 'Chats') && await isCodexWorkspaceOpen(page, workspaceName)) {
      this.routedWorkspace = workspaceName;
      return;
    }

    const clicked = await clickCodexWorkspaceControl(page, workspaceName, mode);
    if (!clicked) {
      const detected = await this.detectWorkspaceState(page);
      throw new Error(`Could not find Codex workspace "${workspaceName}" in the sidebar. Detected workspaces: ${detected.workspaces.join(', ') || 'none'}.`);
    }

    this.routedWorkspace = workspaceName;
    if (mode === 'new') this.routedThread = undefined;
    this.options.logger.info('Routed Codex workspace', { workspaceName, chatMode: mode });
    await page.waitForTimeout(600);
  }

  private async clickNewThreadControl(page: Page, workspaceName?: string): Promise<boolean> {
    if (workspaceName) {
      const clickedWorkspaceNew = await clickCodexWorkspaceNewControl(page, workspaceName);
      if (clickedWorkspaceNew) {
        this.routedWorkspace = workspaceName;
        this.routedThread = undefined;
        return true;
      }
      await this.ensureWorkspace(page, workspaceName, 'current');
    }

    const found = await firstVisible(page, NEW_CHAT_CANDIDATES, 1_000);
    if (!found) return false;
    this.options.logger.info('Clicking new thread control', { selector: found.candidate.name, workspaceName });
    await found.locator.click();
    return true;
  }

  private async detectThreadState(page: Page, workspaceName: string): Promise<ThreadOption[]> {
    const workspaceState = await this.detectWorkspaceState(page);
    return detectCodexThreadState(page, workspaceName, workspaceState.workspaces).catch((error: unknown) => {
      this.options.logger.warn('Could not detect Codex threads', { workspaceName, error: error instanceof Error ? error.message : String(error) });
      return [];
    });
  }

  private async detectWorkspaceState(page: Page): Promise<{ activeWorkspace?: string; workspaces: string[] }> {
    return detectCodexWorkspaceState(page);
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('Codex operation interrupted by stop/pause command.');
  }
}

function namesEqual(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.replace(/\s+/g, ' ').trim().toLowerCase() === right.replace(/\s+/g, ' ').trim().toLowerCase());
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names.map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}
