import type { Page } from 'playwright';
import type { ChatMode, ThreadOption } from './types.js';

export interface CodexRuntimeState {
  stopCount: number;
  runningCount: number;
  sendCount: number;
  composerTextLength: number;
}

export interface WorkspaceState {
  activeWorkspace?: string;
  workspaces: string[];
}

export async function readRuntimeState(page: Page): Promise<CodexRuntimeState> {
  return page.evaluate(() => {
    let stopCount = 0;
    let runningCount = 0;
    let sendCount = 0;
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const element of buttons) {
      const htmlElement = element as HTMLElement & { disabled?: boolean };
      const rect = htmlElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const style = window.getComputedStyle(htmlElement);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (htmlElement.disabled) continue;

      const aria = (element.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const text = (htmlElement.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (aria === 'stop' || aria === 'pause' || aria.includes('stop') || aria.includes('pause') || aria.includes('dừng')) stopCount += 1;
      if (aria === 'send') sendCount += 1;
      if (text.startsWith('running ') || text === 'running') runningCount += 1;
    }

    const composerText = (document.querySelector('[data-codex-composer="true"]')?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return { stopCount, runningCount, sendCount, composerTextLength: composerText.length };
  }).catch(() => ({ stopCount: 0, runningCount: 0, sendCount: 0, composerTextLength: 0 }));
}

export async function isWorkspaceOpen(page: Page, workspaceName: string): Promise<boolean> {
  return page.evaluate((workspaceName) => {
    const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();
    const target = normalize(workspaceName);
    const visible = (element: Element): boolean => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    if (target === 'chats') {
      return Array.from(document.querySelectorAll('nav [role="list"]'))
        .some((element) => normalize(element.getAttribute('aria-label') ?? '') === 'chats' && visible(element));
    }

    return Array.from(document.querySelectorAll('nav [role="listitem"][aria-label]'))
      .some((element) => normalize(element.getAttribute('aria-label') ?? '') === target && visible(element));
  }, workspaceName).catch(() => false);
}

export async function clickWorkspaceNewControl(page: Page, workspaceName: string): Promise<boolean> {
  return page.evaluate((workspaceName) => {
    const target = workspaceName.replace(/\s+/g, ' ').trim().toLowerCase();
    const nav = document.querySelector('nav') ?? document;
    for (const element of Array.from(nav.querySelectorAll('button[aria-label]'))) {
      const node = element as HTMLElement;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      const aria = (element.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (aria === `start new chat in ${target}` && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none') {
        node.click();
        return true;
      }
    }
    return false;
  }, workspaceName).catch(() => false);
}

export async function clickWorkspaceControl(page: Page, workspaceName: string, mode: ChatMode): Promise<boolean> {
  return page.evaluate(({ workspaceName, mode }) => {
    const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
    const target = normalize(workspaceName).toLowerCase();
    const nav = document.querySelector('nav') ?? document;
    const isVisible = (element: Element): boolean => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const workspaceNamesFromAria = (aria: string): string[] => {
      const projectAction = aria.match(/^Project actions for (.+)$/i)?.[1];
      const startNew = aria.match(/^Start new chat in (.+)$/i)?.[1];
      const exact = aria && !/^(archive|pin|filter|collapse|add|new|search|skills|plugins|automations|projects|project actions for|start new chat in|show more)/i.test(aria) ? aria : '';
      return [exact, projectAction, startNew].map((value) => normalize(value ?? '')).filter(Boolean);
    };
    const valuesFor = (element: Element): string[] => {
      const node = element as HTMLElement;
      const rawText = node.innerText || element.textContent || '';
      const aria = normalize(element.getAttribute('aria-label') ?? '');
      const text = normalize(rawText);
      const firstLine = normalize(rawText.split('\n').find(Boolean) ?? '');
      return [aria, text, firstLine, ...workspaceNamesFromAria(aria)].filter(Boolean).map((value) => value.toLowerCase());
    };
    const isWorkspaceAction = (element: Element): boolean => /^(project actions for|start new chat in)/i.test(normalize(element.getAttribute('aria-label') ?? ''));
    const findWorkspaceElement = (): HTMLElement | undefined => {
      for (const element of Array.from(nav.querySelectorAll('a, [role="button"], [role="listitem"], button'))) {
        if (!isVisible(element)) continue;
        if (!valuesFor(element).some((value) => value === target)) continue;

        if (isWorkspaceAction(element)) {
          const root = element.closest('[role="listitem"]');
          if (root && isVisible(root)) {
            const nested = Array.from(root.querySelectorAll('a, [role="button"], [role="listitem"], button'))
              .find((candidate) => candidate !== element && isVisible(candidate) && !isWorkspaceAction(candidate) && valuesFor(candidate).some((value) => value === target));
            return (nested ?? root) as HTMLElement;
          }
        }

        return element as HTMLElement;
      }
      return undefined;
    };

    if (mode === 'new') {
      for (const element of Array.from(nav.querySelectorAll('button[aria-label]'))) {
        const aria = normalize(element.getAttribute('aria-label') ?? '').toLowerCase();
        if (aria === `start new chat in ${target}` && isVisible(element)) {
          (element as HTMLElement).click();
          return true;
        }
      }
    }

    const workspaceElement = findWorkspaceElement();
    if (!workspaceElement) return false;
    workspaceElement.click();

    if (mode === 'new') {
      for (const element of Array.from(nav.querySelectorAll('button[aria-label]'))) {
        const aria = normalize(element.getAttribute('aria-label') ?? '').toLowerCase();
        if (aria === `start new chat in ${target}` && isVisible(element)) {
          (element as HTMLElement).click();
          break;
        }
      }
    }

    return true;
  }, { workspaceName, mode }).catch(() => false);
}

export async function clickThreadControl(page: Page, threadTitle: string): Promise<boolean> {
  return page.evaluate((threadTitle) => {
    const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
    const stripThreadMeta = (value: string): string => normalize(value).replace(/\s+(?:now|\d+[smhdw])$/i, '').trim();
    const target = normalize(threadTitle).toLowerCase();
    const nav = document.querySelector('nav') ?? document;
    for (const element of Array.from(nav.querySelectorAll('a, [role="button"], [role="listitem"], button'))) {
      const node = element as HTMLElement;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      const aria = normalize(element.getAttribute('aria-label') ?? '');
      const text = normalize(node.innerText || element.textContent || '');
      const firstLine = normalize((node.innerText || element.textContent || '').split('\n').find(Boolean) ?? '');
      const values = [aria, text, firstLine, stripThreadMeta(text), stripThreadMeta(firstLine)].filter(Boolean).map((value) => value.toLowerCase());
      if (values.some((value) => value === target)) {
        node.click();
        return true;
      }
    }
    return false;
  }, threadTitle).catch(() => false);
}

export async function detectWorkspaceState(page: Page): Promise<WorkspaceState> {
  return page.evaluate(() => {
    const names = new Set<string>();
    for (const element of Array.from(document.querySelectorAll('nav [role="list"][aria-label], nav [role="button"], nav [role="listitem"], nav button[aria-label]'))) {
      const aria = (element.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim();
      const projectAction = aria.match(/^Project actions for (.+)$/i)?.[1];
      const startNew = aria.match(/^Start new chat in (.+)$/i)?.[1];
      const exact = aria && !/^(archive|pin|filter|collapse|add|new|search|skills|plugins|automations|projects|project actions for|start new chat in|show more)/i.test(aria) ? aria : '';
      for (const candidate of [projectAction, startNew, exact]) {
        const value = (candidate ?? '').replace(/\s+/g, ' ').trim();
        if (value && !value.includes('\n') && !/ctrl\+/i.test(value)) names.add(value);
      }
    }

    const selected = Array.from(document.querySelectorAll('nav [aria-current="true"], nav [aria-selected="true"], nav [data-state="active"]'))
      .map((element) => (element.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim() || ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/g, ' ').trim())
      .find(Boolean);

    return { activeWorkspace: selected || undefined, workspaces: Array.from(names) };
  }).catch(() => ({ workspaces: [] }));
}

export async function detectThreadState(page: Page, workspaceName: string, workspaceNames: string[]): Promise<ThreadOption[]> {
  return page.evaluate(({ workspaceName, workspaceNames }) => {
    const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
    const stripThreadMeta = (value: string): string => normalize(value).replace(/\s+(?:now|\d+[smhdw])$/i, '').trim();
    const workspaceSet = new Set([workspaceName, ...workspaceNames, 'Chats'].map((value) => normalize(value).toLowerCase()).filter(Boolean));
    const blocked = /^(archive(?: chat)?|pin(?: chat)?|filter(?: sidebar chats)?|collapse(?: all)?|add(?: new project)?|new|new chat|search|skills|plugins|automations|projects|show more|settings|help|chats)$/i;
    const action = /^(project actions for|start new chat in|open project actions|more actions)/i;
    const results: { title: string; active?: boolean }[] = [];
    const seen = new Set<string>();
    const nav = document.querySelector('nav') ?? document;
    const roots: Element[] = [];
    const targetWorkspace = normalize(workspaceName).toLowerCase();

    if (targetWorkspace === 'chats') {
      roots.push(...Array.from(nav.querySelectorAll('[role="list"]')).filter((element) => normalize(element.getAttribute('aria-label') ?? '').toLowerCase() === 'chats'));
    } else {
      roots.push(...Array.from(nav.querySelectorAll('[role="listitem"][aria-label]')).filter((element) => normalize(element.getAttribute('aria-label') ?? '').toLowerCase() === targetWorkspace));
    }
    const searchRoots = roots.length > 0 ? roots : [nav];

    for (const root of searchRoots) for (const element of Array.from(root.querySelectorAll('a, [role="button"], [role="listitem"], button'))) {
      const node = element as HTMLElement;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue;

      const aria = normalize(element.getAttribute('aria-label') ?? '');
      const rawText = node.innerText || element.textContent || '';
      const lines = rawText.split('\n').map(normalize).filter(Boolean);
      const title = stripThreadMeta(lines[0] ?? aria);
      const key = title.toLowerCase();
      if (!title || title.length > 220) continue;
      if (blocked.test(title) || action.test(aria) || workspaceSet.has(key)) continue;
      if (/ctrl\+/i.test(title) || title.includes('…') || title === '.') continue;
      if (seen.has(key)) continue;

      const active = element.getAttribute('aria-current') === 'true'
        || element.getAttribute('aria-selected') === 'true'
        || element.getAttribute('data-state') === 'active';
      seen.add(key);
      results.push({ title, active });
    }

    return results.slice(0, 30);
  }, { workspaceName, workspaceNames });
}
