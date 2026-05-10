import type { TextBridge } from '../core/types.js';

export async function runLocalPrompt(bridge: TextBridge, prompt: string): Promise<string> {
  const response = await bridge.handleText({ text: prompt, source: 'local' });
  return response.text;
}
