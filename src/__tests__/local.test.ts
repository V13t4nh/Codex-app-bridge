import { describe, expect, test } from 'vitest';
import { runLocalPrompt } from '../adapters/local.js';
import type { BridgeRequest, BridgeResponse, BridgeTarget, TextBridge, ThreadOption, WorkspaceOption } from '../core/types.js';

class FakeBridge implements TextBridge {
  request?: BridgeRequest;

  async handleText(request: BridgeRequest): Promise<BridgeResponse> {
    this.request = request;
    return { text: `response:${request.text}`, metadata: { responseLength: request.text.length } };
  }

  async newChat(): Promise<string> { return 'new'; }
  async stopOrPause(): Promise<string> { return 'stop'; }
  async getWorkspace(): Promise<string> { return 'workspace'; }
  async listWorkspaces(): Promise<WorkspaceOption[]> { return []; }
  async listThreads(): Promise<ThreadOption[]> { return []; }
  async openThread(_target: BridgeTarget): Promise<string> { return 'thread'; }
}

describe('runLocalPrompt', () => {
  test('forwards prompt through local bridge source', async () => {
    const bridge = new FakeBridge();
    const response = await runLocalPrompt(bridge, 'hello');

    expect(response).toBe('response:hello');
    expect(bridge.request).toEqual({ text: 'hello', source: 'local' });
  });
});
