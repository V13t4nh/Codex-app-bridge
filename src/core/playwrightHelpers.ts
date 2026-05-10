import type { Locator, Page } from 'playwright';
import type { SelectorCandidate } from './types.js';

export function locatorFor(page: Page, candidate: SelectorCandidate): Locator {
  switch (candidate.strategy) {
    case 'role':
      return page.getByRole(candidate.value === 'textbox' ? 'textbox' : 'button', {
        name: candidate.value === 'textbox' ? undefined : new RegExp(candidate.value, 'i'),
      });
    case 'placeholder':
      return page.getByPlaceholder(new RegExp(candidate.value, 'i'));
    case 'aria': {
      const selectors = candidate.value
        .split('|')
        .map((value) => `[aria-label*="${cssEscape(value)}" i]`)
        .join(', ');
      return page.locator(selectors);
    }
    case 'text':
      return page.getByText(new RegExp(candidate.value, 'i'));
    case 'css':
      return page.locator(candidate.value);
  }
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, (match) => `\\${match}`);
}

export async function firstVisible(page: Page, candidates: SelectorCandidate[], timeoutMs = 1_000): Promise<{ candidate: SelectorCandidate; locator: Locator } | undefined> {
  for (const candidate of candidates) {
    const locator = locatorFor(page, candidate).last();
    try {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      return { candidate, locator };
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function firstVisibleEnabled(page: Page, candidates: SelectorCandidate[], timeoutMs = 1_000): Promise<{ candidate: SelectorCandidate; locator: Locator } | undefined> {
  for (const candidate of candidates) {
    const locator = locatorFor(page, candidate).last();
    try {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      if (await locator.isEnabled({ timeout: 100 }).catch(() => false)) return { candidate, locator };
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function fillPrompt(locator: Locator, text: string): Promise<void> {
  await locator.click({ force: true, timeout: 5_000 }).catch(() => undefined);
  await locator.focus({ timeout: 5_000 }).catch(() => undefined);
  const isContentEditable = await locator.evaluate((element) => (element as HTMLElement).isContentEditable).catch(() => false);
  if (isContentEditable) {
    await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => undefined);
    await locator.press('Backspace').catch(() => undefined);
    await locator.type(text, { delay: 5 });
    return;
  }

  try {
    await locator.fill(text, { timeout: 5_000 });
  } catch {
    await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await locator.press('Backspace').catch(() => undefined);
    await locator.type(text, { delay: 5 });
  }
}
