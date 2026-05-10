import type { SelectorCandidate } from './types.js';

export const INPUT_CANDIDATES: SelectorCandidate[] = [
  { name: 'Codex composer', strategy: 'css', value: '[data-codex-composer="true"]' },
  { name: 'textbox role', strategy: 'role', value: 'textbox' },
  { name: 'prompt placeholder', strategy: 'placeholder', value: 'message|prompt|ask|type|send' },
  { name: 'prompt aria label', strategy: 'aria', value: 'message composer|prompt|ask codex|type a message|input' },
  { name: 'contenteditable fallback', strategy: 'css', value: '[contenteditable="true"]' },
  { name: 'textarea fallback', strategy: 'css', value: 'textarea' },
];

export const SEND_CANDIDATES: SelectorCandidate[] = [
  { name: 'Codex composer primary action', strategy: 'css', value: 'button[class*="size-token-button-composer"][class*="bg-token-foreground"]:not([aria-label="Stop"]):not([disabled])' },
  { name: 'Codex send aria exact', strategy: 'css', value: 'button[aria-label="Send"]:not([disabled])' },
  { name: 'Codex composer send icon', strategy: 'css', value: 'button[aria-label*="Send" i][class*="size-token-button-composer"]:not([disabled])' },
  { name: 'send button role', strategy: 'role', value: 'send|submit|send message' },
  { name: 'send aria label', strategy: 'aria', value: 'send|submit|send message|arrow' },
  { name: 'enabled submit button fallback', strategy: 'css', value: 'button[type="submit"]:not([disabled])' },
  { name: 'last enabled composer button fallback', strategy: 'css', value: 'form button:not([disabled]), textarea ~ button:not([disabled]), [contenteditable="true"] ~ button:not([disabled])' },
];

export const RESPONSE_CANDIDATES: SelectorCandidate[] = [
  { name: 'assistant data attribute', strategy: 'css', value: '[data-message-author-role="assistant"]' },
  { name: 'assistant article', strategy: 'css', value: 'article' },
  { name: 'markdown response', strategy: 'css', value: '.markdown, [class*="markdown"], [class*="response"], [class*="message"]' },
];

export const NEW_CHAT_CANDIDATES: SelectorCandidate[] = [
  { name: 'new chat role', strategy: 'role', value: 'new|new chat|chat mới' },
  { name: 'new chat aria', strategy: 'aria', value: 'new|new chat|chat mới' },
  { name: 'new chat text', strategy: 'text', value: 'new|new chat|chat mới' },
];

export const STOP_CANDIDATES: SelectorCandidate[] = [
  { name: 'Codex stop aria exact', strategy: 'css', value: 'button[aria-label="Stop"]:not([disabled])' },
  { name: 'Codex pause aria exact', strategy: 'css', value: 'button[aria-label="Pause"]:not([disabled])' },
  { name: 'stop aria', strategy: 'css', value: 'button[aria-label*="stop" i]:not([disabled]), button[aria-label*="pause" i]:not([disabled]), button[aria-label*="dừng" i]:not([disabled])' },
];
