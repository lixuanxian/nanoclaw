import type { AIConfig, ChannelInfo, Conversation, DeleteInfo, HistoryResponse, RegisteredGroupInfo, ScheduledTaskInfo, SearchResult, SkillInfo, TaskRunLogInfo, UploadedFile } from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// --- Auth ---

export async function login(password: string): Promise<boolean> {
  const body = new URLSearchParams({ password });
  const res = await fetch('/api/login', {
    method: 'POST',
    body,
    credentials: 'same-origin',
    redirect: 'manual',
  });
  // Backend redirects to / on success (302), returns 401 on failure
  return res.type === 'opaqueredirect' || res.ok || res.status === 302 || res.redirected;
}

export function logout(): void {
  window.location.href = '/api/logout';
}

// --- Admin Password ---

export async function getPasswordStatus(): Promise<{ hasPassword: boolean }> {
  const res = await fetch('/api/admin-password/status', { credentials: 'same-origin' });
  return res.json();
}

export async function setPassword(data: { currentPassword?: string; newPassword: string }): Promise<{ ok?: boolean; error?: string }> {
  const res = await fetch('/api/admin-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function removePassword(currentPassword: string): Promise<{ ok?: boolean; error?: string }> {
  const res = await fetch('/api/admin-password', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ currentPassword }),
  });
  return res.json();
}

// --- Conversations ---

export async function getConversations(): Promise<Conversation[]> {
  const data = await request<{ conversations: Conversation[] }>('/api/conversations');
  return Array.isArray(data.conversations) ? data.conversations : [];
}

export async function getDeleteInfo(jid: string): Promise<DeleteInfo> {
  return request(`/api/conversations/${encodeURIComponent(jid)}/delete-info`);
}

export async function markAsRead(jid: string): Promise<void> {
  await request(`/api/conversations/${encodeURIComponent(jid)}/read`, { method: 'POST' });
}

export async function deleteConversation(jid: string, deleteFiles = false): Promise<void> {
  await request(`/api/conversations/${encodeURIComponent(jid)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deleteFiles }),
  });
}

// --- Sessions ---

export async function createSession(sessionId: string): Promise<{ jid: string }> {
  return request('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
}

export async function deleteSession(id: string): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// --- History ---

export async function getHistory(session: string, jid?: string, before?: string): Promise<HistoryResponse> {
  const params = new URLSearchParams();
  if (jid) params.set('jid', jid);
  if (before) params.set('before', before);
  const qs = params.toString();
  const data = await request<HistoryResponse>(`/api/history/${encodeURIComponent(session)}${qs ? `?${qs}` : ''}`);
  return {
    messages: Array.isArray(data.messages) ? data.messages : [],
    olderCount: data.olderCount ?? 0,
  };
}

// --- Message actions ---

export async function deleteMessage(id: string, chatJid: string): Promise<void> {
  await request(`/api/messages/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatJid }),
  });
}

export async function editMessage(id: string, chatJid: string, content: string): Promise<void> {
  await request(`/api/messages/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatJid, content }),
  });
}

/** Load a window of messages centered around a specific timestamp (for search navigation). */
export async function getHistoryAround(session: string, timestamp: string, jid?: string): Promise<HistoryResponse> {
  const params = new URLSearchParams({ around: timestamp });
  if (jid) params.set('jid', jid);
  const data = await request<HistoryResponse>(`/api/history/${encodeURIComponent(session)}?${params}`);
  return {
    messages: Array.isArray(data.messages) ? data.messages : [],
    olderCount: data.olderCount ?? 0,
  };
}

// --- File Upload ---

export async function uploadFiles(session: string, files: File[]): Promise<UploadedFile[]> {
  const form = new FormData();
  files.forEach((f) => form.append('files[]', f));
  const res = await fetch(`/api/upload?session=${encodeURIComponent(session)}`, {
    method: 'POST',
    body: form,
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(`Upload failed: ${res.statusText}`);
  const data = await res.json();
  return Array.isArray(data.files) ? data.files : [];
}

// --- Channels ---

export async function getChannels(): Promise<ChannelInfo[]> {
  const data = await request<{ channels: ChannelInfo[] }>('/api/channels');
  return Array.isArray(data.channels) ? data.channels : [];
}

export function getChannelConfig(id: string): Promise<Record<string, string>> {
  return request(`/api/channels/${encodeURIComponent(id)}/config`);
}

export async function saveChannelConfig(id: string, config: Record<string, string>): Promise<void> {
  await request(`/api/channels/${encodeURIComponent(id)}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export async function enableChannel(id: string): Promise<void> {
  await request(`/api/channels/${encodeURIComponent(id)}/enable`, { method: 'POST' });
}

export async function disableChannel(id: string): Promise<void> {
  await request(`/api/channels/${encodeURIComponent(id)}/disable`, { method: 'POST' });
}

export async function startWhatsApp(): Promise<{ status: string; qr?: string }> {
  return request('/api/channels/whatsapp/start', { method: 'POST' });
}

export function getWhatsAppStatus(): Promise<{ status: string; qr?: string; error?: string }> {
  return request('/api/channels/whatsapp/status');
}

// --- AI Config ---

export async function getAIConfig(): Promise<AIConfig> {
  const data = await request<AIConfig>('/api/ai-config');
  return {
    config: data.config ?? { default_provider: '', providers: {} },
    providers: Array.isArray(data.providers) ? data.providers : [],
  };
}

export async function saveAIConfig(data: {
  default_provider: string;
  providers: Record<string, { model?: string; api_base?: string; api_key?: string }>;
}): Promise<void> {
  await request('/api/ai-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

// --- Session Provider ---

export async function getSessionProvider(sessionId: string): Promise<{ providerId: string; provider: string; model: string }> {
  return request<{ providerId: string; provider: string; model: string }>(`/api/provider/${encodeURIComponent(sessionId)}`);
}

// --- Skills ---

export async function getSkills(): Promise<SkillInfo[]> {
  const data = await request<{ skills: SkillInfo[] }>('/api/skills');
  return Array.isArray(data.skills) ? data.skills : [];
}

export async function createSkill(data: { name: string; description: string; content: string }): Promise<SkillInfo> {
  return request('/api/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function deleteSkill(id: string): Promise<void> {
  await request(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function toggleSkill(id: string, enabled: boolean): Promise<void> {
  await request(`/api/skills/${encodeURIComponent(id)}/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

export async function installRemoteSkill(url: string): Promise<SkillInfo> {
  return request('/api/skills/install-remote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}

// --- Groups ---

export async function getGroups(): Promise<RegisteredGroupInfo[]> {
  const data = await request<{ groups: RegisteredGroupInfo[] }>('/api/groups');
  return Array.isArray(data.groups) ? data.groups : [];
}

export async function updateGroup(jid: string, updates: {
  name?: string;
  trigger?: string;
  requiresTrigger?: boolean;
  containerConfig?: { provider?: string; model?: string } | null;
}): Promise<void> {
  await request(`/api/groups/${encodeURIComponent(jid)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
}

// --- Tasks ---

export async function getTasks(folder?: string): Promise<ScheduledTaskInfo[]> {
  const qs = folder ? `?folder=${encodeURIComponent(folder)}` : '';
  const data = await request<{ tasks: ScheduledTaskInfo[] }>(`/api/tasks${qs}`);
  return Array.isArray(data.tasks) ? data.tasks : [];
}

export async function createTaskApi(data: {
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode?: 'group' | 'isolated';
}): Promise<{ ok: boolean; id: string }> {
  return request('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function updateTaskApi(id: string, updates: {
  prompt?: string;
  schedule_type?: 'cron' | 'interval' | 'once';
  schedule_value?: string;
  status?: 'active' | 'paused';
  context_mode?: 'group' | 'isolated';
}): Promise<void> {
  await request(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
}

export async function deleteTaskApi(id: string): Promise<void> {
  await request(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function getTaskLogs(id: string): Promise<{ task: ScheduledTaskInfo; logs: TaskRunLogInfo[] }> {
  return request(`/api/tasks/${encodeURIComponent(id)}/logs`);
}

// --- Search ---

export async function searchMessages(
  query: string,
  jid?: string,
  limit = 20,
  offset = 0,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query });
  if (jid) params.set('jid', jid);
  if (limit !== 20) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  const data = await request<{ results: SearchResult[] }>(`/api/search?${params}`);
  return Array.isArray(data.results) ? data.results : [];
}

export async function aiSearchMessages(
  query: string,
  jid?: string,
  limit = 20,
  offset = 0,
  lang?: string,
): Promise<{ results: SearchResult[]; aiKeywords: string; error?: string }> {
  const params = new URLSearchParams({ q: query });
  if (jid) params.set('jid', jid);
  if (limit !== 20) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  if (lang) params.set('lang', lang);
  const data = await request<{ results: SearchResult[]; aiKeywords: string; error?: string }>(`/api/search/ai?${params}`);
  return {
    results: Array.isArray(data.results) ? data.results : [],
    aiKeywords: data.aiKeywords || '',
    error: data.error,
  };
}

// --- Export ---

export function getExportUrl(jid: string, format: 'json' | 'md' | 'csv'): string {
  return `/api/export/${encodeURIComponent(jid)}?format=${format}`;
}

// --- Logs ---

export interface LogFileInfo {
  name: string;
  timestamp: string;
  size: number;
  modifiedAt: string;
}

export async function getLogs(folder: string): Promise<LogFileInfo[]> {
  const data = await request<{ logs: LogFileInfo[] }>(`/api/logs/${encodeURIComponent(folder)}`);
  return Array.isArray(data.logs) ? data.logs : [];
}

export async function getLogContent(folder: string, filename: string): Promise<string> {
  const data = await request<{ content: string }>(`/api/logs/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`);
  return data.content || '';
}

export async function deleteLog(folder: string, filename: string): Promise<void> {
  await request(`/api/logs/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`, { method: 'DELETE' });
}

export async function cleanupLogs(folder: string, keep = 3): Promise<{ deleted: string[]; remaining: number }> {
  return request(`/api/logs/${encodeURIComponent(folder)}/cleanup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keep }),
  });
}

// --- Live Logs ---

export async function getContainerStatus(folder: string): Promise<{ running: boolean; containerName: string | null }> {
  return request(`/api/container-status/${encodeURIComponent(folder)}`);
}

// --- Workspace File Browser ---

export interface FolderConversation {
  jid: string;
  name: string;
  channel: string;
}

export interface FolderInfo {
  folder: string;
  hasConversation: boolean;
  conversationCount: number;
  protected?: boolean;
  conversations?: FolderConversation[];
}

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
  editable: boolean;
}

export async function getWorkspaceFolders(): Promise<{ folders: FolderInfo[]; rootFiles: FileEntry[] }> {
  const data = await request<{ folders: FolderInfo[]; rootFiles: FileEntry[] }>('/api/workspace/folders');
  return {
    folders: Array.isArray(data.folders) ? data.folders : [],
    rootFiles: Array.isArray(data.rootFiles) ? data.rootFiles : [],
  };
}

export async function readRootFile(fileName: string): Promise<{ content: string; editable: boolean; size: number }> {
  return request(`/api/workspace/root/read/${encodeURIComponent(fileName)}`);
}

export function getRootFileRawUrl(fileName: string, download?: boolean): string {
  const route = `/api/workspace/root/raw/${encodeURIComponent(fileName)}`;
  return download ? `${route}?download=1` : route;
}

export async function writeRootFile(fileName: string, content: string): Promise<void> {
  await request(`/api/workspace/root/write/${encodeURIComponent(fileName)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

export async function deleteRootFile(fileName: string): Promise<void> {
  await request(`/api/workspace/root/delete/${encodeURIComponent(fileName)}`, { method: 'DELETE' });
}

export async function browseFolder(folder: string, subpath?: string): Promise<{ path: string; files: FileEntry[] }> {
  const route = subpath
    ? `/api/workspace/browse/${encodeURIComponent(folder)}/${subpath.split('/').map(encodeURIComponent).join('/')}`
    : `/api/workspace/browse/${encodeURIComponent(folder)}`;
  const data = await request<{ path: string; files: FileEntry[] }>(route);
  return { path: data.path || '', files: Array.isArray(data.files) ? data.files : [] };
}

export async function readWorkspaceFile(folder: string, subpath: string): Promise<{ content: string; editable: boolean; size: number }> {
  const route = `/api/workspace/read/${encodeURIComponent(folder)}/${subpath.split('/').map(encodeURIComponent).join('/')}`;
  return request(route);
}

export async function writeWorkspaceFile(folder: string, subpath: string, content: string): Promise<void> {
  const route = `/api/workspace/write/${encodeURIComponent(folder)}/${subpath.split('/').map(encodeURIComponent).join('/')}`;
  await request(route, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

export async function deleteWorkspaceItem(folder: string, subpath: string): Promise<void> {
  const route = `/api/workspace/delete/${encodeURIComponent(folder)}/${subpath.split('/').map(encodeURIComponent).join('/')}`;
  await request(route, { method: 'DELETE' });
}

export async function renameWorkspaceItem(folder: string, from: string, to: string): Promise<void> {
  await request(`/api/workspace/rename/${encodeURIComponent(folder)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
}

/** Build a URL to the raw file endpoint (for download, PDF/audio/video preview). */
export function getWorkspaceFileRawUrl(folder: string, subpath: string, download?: boolean): string {
  const route = `/api/workspace/raw/${encodeURIComponent(folder)}/${subpath.split('/').map(encodeURIComponent).join('/')}`;
  return download ? `${route}?download=1` : route;
}

export async function createWorkspaceFile(folder: string, subpath: string): Promise<void> {
  const route = `/api/workspace/touch/${encodeURIComponent(folder)}/${subpath.split('/').map(encodeURIComponent).join('/')}`;
  await request(route, { method: 'POST' });
}

export async function createWorkspaceFolder(folder: string, subpath: string): Promise<void> {
  const route = `/api/workspace/mkdir/${encodeURIComponent(folder)}/${subpath.split('/').map(encodeURIComponent).join('/')}`;
  await request(route, { method: 'POST' });
}

export async function cleanupOrphanFolders(): Promise<string[]> {
  const data = await request<{ deleted: string[] }>('/api/workspace/cleanup-orphans', { method: 'POST' });
  return Array.isArray(data.deleted) ? data.deleted : [];
}
