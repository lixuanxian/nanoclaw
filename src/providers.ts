/**
 * AI Provider registry for NanoClaw
 * Maps provider IDs to their configuration (API base URL, default model, secret key name).
 *
 * Providers:
 *   claude            — Claude Agent SDK (default when Claude CLI is available locally)
 *   claude-compatible — Claude / Claude Compatible API (Anthropic Messages format)
 *   openai-compatible — OpenAI / OpenAI Compatible API (chat completions format)
 *   minimax           — MiniMax
 *   deepseek          — DeepSeek
 *   qwen              — QWEN
 *   doubao            — DOUBAO
 */

export interface ProviderConfig {
  id: string;
  name: string;
  apiBase: string;
  defaultModel: string;
  secretEnvVar: string;
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  claude: {
    id: 'claude',
    name: 'Claude CLI',
    apiBase: '',
    defaultModel: 'claude-sonnet-4-6',
    secretEnvVar: 'ANTHROPIC_API_KEY',
  },
  'claude-compatible': {
    id: 'claude-compatible',
    name: 'Claude Compatible',
    apiBase: '',
    defaultModel: 'claude-sonnet-4-6',
    secretEnvVar: 'CLAUDE_COMPATIBLE_API_KEY',
  },
  'openai-compatible': {
    id: 'openai-compatible',
    name: 'OpenAI Compatible',
    apiBase: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.3-codex',
    secretEnvVar: 'OPENAI_API_KEY',
  },
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    apiBase: 'https://api.minimax.chat/v1',
    defaultModel: 'MiniMax-M2.5',
    secretEnvVar: 'MINIMAX_API_KEY',
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    apiBase: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    secretEnvVar: 'DEEPSEEK_API_KEY',
  },
  qwen: {
    id: 'qwen',
    name: 'QWEN',
    apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    secretEnvVar: 'QWEN_API_KEY',
  },
  doubao: {
    id: 'doubao',
    name: 'DOUBAO',
    apiBase: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'Doubao-Seed-2.0-Code',
    secretEnvVar: 'DOUBAO_API_KEY',
  },
};

/** Ordered list of provider IDs for UI display. */
export const PROVIDER_ORDER = [
  'claude',
  'claude-compatible',
  'openai-compatible',
  'deepseek',
  'minimax',
  'qwen',
  'doubao',
];

export function getProvider(id: string): ProviderConfig | undefined {
  const base = PROVIDERS[id];
  if (!base) return undefined;

  // Allow env var overrides: {PROVIDER_ID}_API_BASE, {PROVIDER_ID}_DEFAULT_MODEL
  const envPrefix = id.toUpperCase().replace(/-/g, '_');
  const envApiBase = process.env[`${envPrefix}_API_BASE`];
  const envDefaultModel = process.env[`${envPrefix}_DEFAULT_MODEL`];

  // Also check generic AI_API_BASE, AI_DEFAULT_MODEL as lowest-priority overrides
  const genericApiBase = process.env['AI_API_BASE'];
  const genericDefaultModel = process.env['AI_DEFAULT_MODEL'];

  const finalApiBase = envApiBase || base.apiBase || genericApiBase;
  const finalDefaultModel =
    envDefaultModel || base.defaultModel || genericDefaultModel;

  if (finalApiBase === base.apiBase && finalDefaultModel === base.defaultModel)
    return base;

  return {
    ...base,
    apiBase: finalApiBase || base.apiBase,
    defaultModel: finalDefaultModel || base.defaultModel,
  };
}

export function getProviderSecretKeys(): string[] {
  return [...new Set(Object.values(PROVIDERS).map((p) => p.secretEnvVar))];
}
