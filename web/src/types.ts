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

export interface RegisteredGroupInfo {
  jid: string;
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  requiresTrigger: boolean;
  containerConfig: { provider?: string; model?: string } | null;
}

export interface ScheduledTaskInfo {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLogInfo {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

export interface SearchResult {
  id: string;
  chatJid: string;
  sender: string;
  content: string;
  timestamp: string;
  isBot: boolean;
  snippet: string;
}

export interface DeleteInfo {
  folder: string | null;
  isLastJid: boolean;
  hasFiles: boolean;
  taskCount: number;
}

export type ThemeMode = 'system' | 'dark' | 'light';

export interface WsMessage {
  type: 'message' | 'typing' | 'history';
  text?: string;
  isTyping?: boolean;
  olderCount?: number;
  messages?: Message[];
}
