import type { Page } from 'playwright';

export interface DomControl {
  tag: string;
  aria: string;
  text: string;
  placeholder: string;
  visible: boolean;
  disabled: boolean;
  role: string;
}

export async function getDomControls(page: Page): Promise<DomControl[]> {
  return page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll('button, textarea, input, [contenteditable="true"], [aria-label], [role]'));
    return elements.slice(0, 160).map((element) => {
      const htmlElement = element as HTMLElement;
      const rect = htmlElement.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        aria: element.getAttribute('aria-label') ?? '',
        text: (element.textContent ?? '').trim().slice(0, 120),
        placeholder: element.getAttribute('placeholder') ?? '',
        visible: rect.width > 0 && rect.height > 0,
        disabled: Boolean((htmlElement as HTMLButtonElement).disabled) || element.getAttribute('aria-disabled') === 'true',
        role: element.getAttribute('role') ?? '',
      };
    });
  });
}

export function formatDomControl(control: DomControl): string {
  return `${control.tag} role=${control.role} aria=${control.aria} placeholder=${control.placeholder} text=${control.text} visible=${control.visible} disabled=${control.disabled}`;
}
