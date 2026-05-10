import type { Page } from 'playwright';

export interface ResponseSnapshot {
  source: string;
  items: string[];
  htmlItems?: string[];
}

export interface SelectedResponse {
  text: string;
  formattedText?: string;
  format?: 'html';
}

interface ResponseSelectorGroup {
  source: string;
  selector: string;
}

interface ResponseDomItem {
  text: string;
  html: string;
}

const RESPONSE_GROUPS: ResponseSelectorGroup[] = [
  {
    source: 'assistant-attribute',
    selector: '[data-message-author-role="assistant"], [data-testid*="assistant" i], [aria-label*="assistant" i]',
  },
  {
    source: 'codex-markdown-content',
    selector: '[class*="markdownContent" i]',
  },
  {
    source: 'assistant-class',
    selector: '[class*="assistant" i]',
  },
  {
    source: 'article',
    selector: 'article, [role="article"]',
  },
  {
    source: 'message-markdown',
    selector: '.markdown, [class*="markdown" i], [class*="response" i], [class*="message" i]',
  },
];

export async function readResponseSnapshot(page: Page): Promise<ResponseSnapshot> {
  for (const group of RESPONSE_GROUPS) {
    const items = await page.evaluate((selector) => {
      const blockTags = new Set([
        'article', 'aside', 'blockquote', 'div', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'header', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'th', 'thead',
        'tr', 'ul',
      ]);

      const escapeHtml = (value: string): string => value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      const escapeAttribute = (value: string): string => escapeHtml(value).replace(/"/g, '&quot;');

      const normalizeVisibleText = (value: string): string => value.replace(/\s+/g, ' ').trim();

      const normalizeTelegramHtml = (value: string): string => value
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      const hasBlockChild = (element: Element): boolean => Array
        .from(element.children)
        .some((child) => blockTags.has(child.tagName.toLowerCase()));

      const block = (value: string): string => {
        const normalized = normalizeTelegramHtml(value);
        return normalized ? `${normalized}\n\n` : '';
      };

      const sanitizeHref = (href: string | null): string | undefined => {
        if (!href) return undefined;
        try {
          const url = new URL(href, document.baseURI);
          if (['http:', 'https:', 'tg:'].includes(url.protocol)) return url.href;
        } catch {
          return undefined;
        }
        return undefined;
      };

      const renderChildren = (element: Element): string => Array
        .from(element.childNodes)
        .map((child) => renderNode(child))
        .join('');

      const renderList = (element: Element, ordered: boolean): string => {
        let index = 1;
        let result = '';
        for (const child of Array.from(element.children)) {
          if (child.tagName.toLowerCase() !== 'li') continue;
          const content = normalizeTelegramHtml(renderChildren(child)).replace(/\n/g, '\n  ');
          if (!content) continue;
          result += `${ordered ? `${index}.` : '-'} ${content}\n`;
          index += 1;
        }
        return result ? `${result}\n` : '';
      };

      function renderNode(node: Node): string {
        if (node.nodeType === Node.TEXT_NODE) return escapeHtml((node.textContent ?? '').replace(/\s+/g, ' '));
        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        const element = node as HTMLElement;
        const tag = element.tagName.toLowerCase();
        if (['button', 'input', 'select', 'script', 'style', 'svg', 'textarea'].includes(tag)) return '';

        if (tag === 'br') return '\n';
        if (tag === 'pre') {
          const code = (element.innerText || element.textContent || '').replace(/\s+$/g, '');
          return code ? `<pre>${escapeHtml(code)}</pre>\n\n` : '';
        }
        if (tag === 'code') return `<code>${escapeHtml(element.textContent ?? '')}</code>`;
        if (tag === 'strong' || tag === 'b') return `<b>${normalizeTelegramHtml(renderChildren(element))}</b>`;
        if (tag === 'em' || tag === 'i') return `<i>${normalizeTelegramHtml(renderChildren(element))}</i>`;
        if (tag === 'u' || tag === 'ins') return `<u>${normalizeTelegramHtml(renderChildren(element))}</u>`;
        if (tag === 's' || tag === 'strike' || tag === 'del') return `<s>${normalizeTelegramHtml(renderChildren(element))}</s>`;
        if (tag === 'a') {
          const content = normalizeTelegramHtml(renderChildren(element));
          const href = sanitizeHref(element.getAttribute('href'));
          return href && content ? `<a href="${escapeAttribute(href)}">${content}</a>` : content;
        }
        if (/^h[1-6]$/.test(tag)) return block(`<b>${normalizeTelegramHtml(renderChildren(element))}</b>`);
        if (tag === 'p') return block(renderChildren(element));
        if (tag === 'ul') return renderList(element, false);
        if (tag === 'ol') return renderList(element, true);
        if (tag === 'li') return `- ${normalizeTelegramHtml(renderChildren(element))}\n`;
        if (tag === 'blockquote') {
          const content = normalizeTelegramHtml(renderChildren(element));
          return content ? `${content.split('\n').map((line) => `&gt; ${line}`).join('\n')}\n\n` : '';
        }
        if (tag === 'table') {
          const content = normalizeTelegramHtml(element.innerText || element.textContent || '');
          return content ? `<pre>${escapeHtml(content)}</pre>\n\n` : '';
        }

        const content = renderChildren(element);
        return hasBlockChild(element) ? content : normalizeTelegramHtml(content);
      }

      const renderTelegramHtml = (element: HTMLElement, plainText: string): string => {
        const rendered = renderChildren(element);
        const html = rendered.includes('<pre>') ? rendered.trim() : normalizeTelegramHtml(rendered);
        return html || escapeHtml(plainText);
      };

      const elements = Array.from(document.querySelectorAll(selector));
      const elementSet = new Set(elements);
      return elements
        .filter((element) => {
          const node = element as HTMLElement;
          let parent = node.parentElement;
          while (parent) {
            if (elementSet.has(parent)) return false;
            parent = parent.parentElement;
          }
          const tag = node.tagName.toLowerCase();
          if (['button', 'input', 'textarea', 'select'].includes(tag)) return false;
          if (node.closest('[contenteditable="true"], input, textarea, select')) return false;
          const rect = node.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = window.getComputedStyle(node);
          return style.visibility !== 'hidden' && style.display !== 'none';
        })
        .map((element) => {
          const node = element as HTMLElement;
          const text = normalizeVisibleText(node.innerText || node.textContent || '');
          return { text, html: renderTelegramHtml(node, text) };
        })
        .filter((item) => item.text.length > 0);
    }, group.selector).catch((): ResponseDomItem[] => []);

    const deduped = dedupeConsecutive(items);
    if (deduped.length > 0) {
      return {
        source: group.source,
        items: deduped.map((item) => item.text),
        htmlItems: deduped.map((item) => item.html),
      };
    }
  }

  return { source: 'none', items: [] };
}

export function selectNewResponse(before: ResponseSnapshot, current: ResponseSnapshot, prompt: string): SelectedResponse | undefined {
  const beforeItems = before.items.map(normalizeText);
  const currentItems = current.items
    .map((text, index) => ({ text: normalizeText(text), index }))
    .filter((item) => Boolean(item.text));

  if (currentItems.length === 0) return undefined;

  if (currentItems.length > beforeItems.length) {
    for (let position = currentItems.length - 1; position >= beforeItems.length; position -= 1) {
      const candidate = currentItems[position];
      if (candidate && !isPromptEcho(candidate.text, prompt)) return toSelectedResponse(current, candidate.index, candidate.text);
    }
    return undefined;
  }

  const lastCurrent = currentItems[currentItems.length - 1];
  const lastBefore = beforeItems[beforeItems.length - 1];
  if (lastCurrent && lastCurrent.text !== lastBefore && !isPromptEcho(lastCurrent.text, prompt)) {
    return toSelectedResponse(current, lastCurrent.index, lastCurrent.text);
  }

  if (currentItems.length < beforeItems.length && lastCurrent && !isPromptEcho(lastCurrent.text, prompt)) {
    return toSelectedResponse(current, lastCurrent.index, lastCurrent.text);
  }
  return undefined;
}

export function selectNewResponseText(before: ResponseSnapshot, current: ResponseSnapshot, prompt: string): string | undefined {
  return selectNewResponse(before, current, prompt)?.text;
}

export function snapshotSummary(snapshot: ResponseSnapshot): string {
  const last = snapshot.items[snapshot.items.length - 1] ?? '';
  return `${snapshot.source}:${snapshot.items.length}:last=${last.length}`;
}

function dedupeConsecutive(items: ResponseDomItem[]): ResponseDomItem[] {
  const result: ResponseDomItem[] = [];
  for (const item of items) {
    const text = normalizeText(item.text);
    if (!text) continue;
    if (result[result.length - 1]?.text !== text) result.push({ text, html: item.html });
  }
  return result;
}

function toSelectedResponse(snapshot: ResponseSnapshot, index: number, text: string): SelectedResponse {
  const formattedText = snapshot.htmlItems?.[index]?.trim();
  return formattedText ? { text, formattedText, format: 'html' } : { text };
}

function isPromptEcho(candidate: string, prompt: string): boolean {
  const normalizedCandidate = normalizeForCompare(candidate);
  const normalizedPrompt = normalizeForCompare(prompt);
  if (!normalizedPrompt) return false;
  if (normalizedCandidate === normalizedPrompt) return true;
  return normalizedCandidate.endsWith(normalizedPrompt) && normalizedCandidate.length <= normalizedPrompt.length + 24;
}

function normalizeText(value: string): string {
  return value.replace(/\u200B/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeForCompare(value: string): string {
  return normalizeText(value).toLowerCase();
}
