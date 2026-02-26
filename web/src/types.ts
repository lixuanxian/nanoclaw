export interface Message {
  content: string;
  sender: string;
  timestamp: string;
  is_bot: boolean;
  channel?: string;
}

export interface Conversation {
  jid: string;
  name: string;
  channel: string;
  preview: string;
  lastMessageTime: string;
}

export interface HistoryResponse {
  olderCount: number;
  messages: Message[];
}

export interface UploadedFile {
  name: string;
  storedName: string;
  size: number;
  type: string;
  url: string;
}

export interface ChannelField {
  key: string;
  label: string;
  type: string;
  placeholder: string;
}

export interface ChannelInfo {
  id: string;
  name: string;
  status: string;
  enabled: boolean;
  configurable: boolean;
  fields?: ChannelField[];
  config?: Record<string, string>;
  guideKeys?: string[];
}

export interface ProviderInfo {
  id: string;
  name: string;
  apiBase: string;
  defaultModel: string;
}

export interface AIConfig {
  config: {
    default_provider: string;
    providers: Record<string, { model?: string; api_base?: string; api_key?: string }>;
  };
  providers: ProviderInfo[];
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  type: 'builtin' | 'custom';
  enabled: boolean;
}

export type ThemeMode = 'system' | 'dark' | 'light';

export interface WsMessage {
  type: 'message' | 'typing' | 'history';
  text?: string;
  isTyping?: boolean;
  olderCount?: number;
  messages?: Message[];
}
