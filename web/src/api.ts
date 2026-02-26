import type { AIConfig, ChannelInfo, Conversation, HistoryResponse, SkillInfo, UploadedFile } from './types';

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

// --- Conversations ---

export async function getConversations(): Promise<Conversation[]> {
  const data = await request<{ conversations: Conversation[] }>('/api/conversations');
  return Array.isArray(data.conversations) ? data.conversations : [];
}

export async function deleteConversation(jid: string): Promise<void> {
  await request(`/api/conversations/${encodeURIComponent(jid)}`, { method: 'DELETE' });
}

// --- Sessions ---

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
