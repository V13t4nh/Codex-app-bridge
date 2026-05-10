export interface BridgeRequest {
  text: string;
  userId?: number;
  source: 'local' | 'telegram' | 'test';
  target?: BridgeTarget;
}

export interface BridgeTarget {
  workspaceName?: string;
  threadTitle?: string;
  newThread?: boolean;
}

export interface BridgeResponse {
  text: string;
  formattedText?: string;
  format?: 'html';
  metadata: {
    responseLength: number;
    pageTitle?: string;
    pageUrl?: string;
  };
}

export interface TextBridge {
  handleText(request: BridgeRequest): Promise<BridgeResponse>;
  newChat(): Promise<string>;
  stopOrPause(): Promise<string>;
  getWorkspace(): Promise<string>;
  listWorkspaces(): Promise<WorkspaceOption[]>;
  listThreads(workspaceName: string): Promise<ThreadOption[]>;
  openThread(target: BridgeTarget): Promise<string>;
}

export interface WorkspaceOption {
  name: string;
  active?: boolean;
}

export interface ThreadOption {
  title: string;
  active?: boolean;
}

export interface SelectorCandidate {
  name: string;
  strategy: 'role' | 'placeholder' | 'aria' | 'text' | 'css';
  value: string;
}

export interface DiscoveryResult {
  pageTitle: string;
  pageUrl: string;
  targetWorkspace?: string;
  chatMode: ChatMode;
  activeWorkspace?: string;
  inputSelector?: SelectorCandidate;
  sendSelector?: SelectorCandidate;
  responseSelector?: SelectorCandidate;
  diagnostics: string[];
}

export type ChatMode = 'current' | 'new';
