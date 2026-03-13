/**
 * Channel configuration persistence.
 * Stores webhook URLs, tokens, and other channel-specific config
 * in store/channel-config.json.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CHANNELS, STORE_DIR } from './config.js';
import { getProvider } from './providers.js';

const CONFIG_PATH = path.join(STORE_DIR, 'channel-config.json');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AllConfigs = Record<string, any>;

function readAll(): AllConfigs {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch {
    // Corrupted file — start fresh
  }
  return {};
}

function writeAll(configs: AllConfigs): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(configs, null, 2) + '\n');
}

export function loadChannelConfig(channelId: string): Record<string, string> {
  return readAll()[channelId] || {};
}

export function saveChannelConfig(
  channelId: string,
  config: Record<string, string>,
): void {
  const all = readAll();
  // Remove empty values
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    if (v) cleaned[k] = v;
  }
  if (Object.keys(cleaned).length === 0) {
    delete all[channelId];
  } else {
    all[channelId] = cleaned;
  }
  writeAll(all);
}

export function isChannelConfigured(channelId: string): boolean {
  const config = loadChannelConfig(channelId);
  return Object.keys(config).length > 0;
}

/** Return config with secret values masked (for API responses). */
export function loadChannelConfigRedacted(
  channelId: string,
): Record<string, string> {
  const config = loadChannelConfig(channelId);
  const redacted: Record<string, string> = {};
  const secretKeys = new Set([
    'secret',
    'signing_secret',
    'bot_token',
    'app_token',
    'client_secret',
  ]);
  for (const [k, v] of Object.entries(config)) {
    if (secretKeys.has(k) && v.length > 4) {
      redacted[k] = v.slice(0, 4) + '****';
    } else {
      redacted[k] = v;
    }
  }
  return redacted;
}

// --- Multi-provider AI configuration ---

const AI_CONFIG_KEY = '_ai';

export interface AiProviderSettings {
  model: string;
  api_base: string;
  api_key: string;
}

export interface AiConfig {
  default_provider: string;
  providers: Record<string, AiProviderSettings>;
}

/** Resolved config for the active default provider. */
export interface ResolvedProviderConfig {
  provider: string;
  model: string;
  api_base: string;
  api_key: string;
}

function emptySettings(): AiProviderSettings {
  return { model: '', api_base: '', api_key: '' };
}

/**
 * Load full AI config (all providers + default selection).
 * Auto-migrates from old single-provider format if detected.
 */
export function loadAiConfig(): AiConfig {
  const all = readAll();
  const raw = all[AI_CONFIG_KEY];

  if (!raw || typeof raw !== 'object') {
    return { default_provider: '', providers: {} };
  }

  // New format: has 'default_provider' and 'providers' keys
  if ('default_provider' in raw || 'providers' in raw) {
    return {
      default_provider: raw.default_provider || '',
      providers: raw.providers || {},
    };
  }

  // Old format migration: { provider, model, api_base, api_key }
  if ('provider' in raw && typeof raw.provider === 'string') {
    const migrated: AiConfig = {
      default_provider: raw.provider || '',
      providers: {},
    };
    if (raw.provider) {
      migrated.providers[raw.provider] = {
        model: raw.model || '',
        api_base: raw.api_base || '',
        api_key: raw.api_key || '',
      };
    }
    // Save migrated format
    all[AI_CONFIG_KEY] = migrated;
    writeAll(all);
    return migrated;
  }

  return { default_provider: '', providers: {} };
}

export function saveAiConfig(config: AiConfig): void {
  const all = readAll();
  // Clean empty provider settings
  const cleaned: Record<string, AiProviderSettings> = {};
  for (const [id, settings] of Object.entries(config.providers)) {
    if (settings.model || settings.api_base || settings.api_key) {
      cleaned[id] = settings;
    }
  }
  all[AI_CONFIG_KEY] = {
    default_provider: config.default_provider,
    providers: cleaned,
  };
  writeAll(all);
  applyAiConfigToEnv();
}

/** Return config with all API keys masked. */
export function loadAiConfigRedacted(): AiConfig {
  const config = loadAiConfig();
  const redacted: Record<string, AiProviderSettings> = {};
  for (const [id, settings] of Object.entries(config.providers)) {
    redacted[id] = {
      ...settings,
      api_key:
        settings.api_key?.length > 4
          ? settings.api_key.slice(0, 4) + '****'
          : settings.api_key
            ? '****'
            : '',
    };
  }
  return { default_provider: config.default_provider, providers: redacted };
}

/** Cache for Claude CLI detection (checked once per process). */
let _claudeCliAvailable: boolean | undefined;

/** Check if Claude CLI binary is available on the host. */
export function isClaudeCliAvailable(): boolean {
  if (_claudeCliAvailable === undefined) {
    try {
      execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
      _claudeCliAvailable = true;
    } catch {
      _claudeCliAvailable = false;
    }
  }
  return _claudeCliAvailable;
}

/** Cache for Copilot CLI detection (checked once per process). */
let _copilotCliAvailable: boolean | undefined;

/** Check if GitHub Copilot CLI binary is available on the host. */
export function isCopilotCliAvailable(): boolean {
  if (_copilotCliAvailable === undefined) {
    try {
      execSync('copilot version', { stdio: 'pipe', timeout: 5000 });
      _copilotCliAvailable = true;
    } catch {
      _copilotCliAvailable = false;
    }
  }
  return _copilotCliAvailable;
}

/**
 * Resolve the active default provider's config for use in the agent pipeline.
 * Priority: settings page > env vars > claude (if CLI available) > none.
 * When no provider is configured and Claude CLI is not available,
 * returns an empty provider — the user can configure one via Settings.
 */
export function loadDefaultProviderConfig(): ResolvedProviderConfig {
  const config = loadAiConfig();
  const providerId =
    config.default_provider ||
    (isClaudeCliAvailable() ? 'claude' : '') ||
    (isCopilotCliAvailable() ? 'copilot' : '');
  const providerConfig = providerId ? getProvider(providerId) : undefined;
  const settings =
    (providerId && config.providers[providerId]) || emptySettings();

  return {
    provider: providerId,
    model: settings.model || providerConfig?.defaultModel || '',
    api_base: settings.api_base || providerConfig?.apiBase || '',
    api_key: settings.api_key || '',
  };
}

// --- Admin password persistence ---

const ADMIN_CONFIG_KEY = '_admin';

/** Load the saved admin password (empty string if not set). */
export function loadAdminPassword(): string {
  const all = readAll();
  const admin = all[ADMIN_CONFIG_KEY];
  if (
    admin &&
    typeof admin === 'object' &&
    typeof admin.password === 'string'
  ) {
    return admin.password;
  }
  return '';
}

/** Save admin password to persistent config. */
export function saveAdminPassword(password: string): void {
  const all = readAll();
  if (password) {
    all[ADMIN_CONFIG_KEY] = { password };
  } else {
    delete all[ADMIN_CONFIG_KEY];
  }
  writeAll(all);
}

/** Remove admin password from persistent config. */
export function clearAdminPassword(): void {
  const all = readAll();
  delete all[ADMIN_CONFIG_KEY];
  writeAll(all);
}

// --- Enabled channels persistence ---

const CHANNELS_CONFIG_KEY = '_channels';

/** Load the list of enabled channel IDs. Falls back to CHANNELS env var. */
export function loadEnabledChannels(): string[] {
  const all = readAll();
  const saved = all[CHANNELS_CONFIG_KEY];
  if (Array.isArray(saved) && saved.length > 0) {
    return saved.filter((s: unknown) => typeof s === 'string' && s);
  }
  return CHANNELS;
}

/** Persist the list of enabled channel IDs. */
export function saveEnabledChannels(ids: string[]): void {
  const all = readAll();
  all[CHANNELS_CONFIG_KEY] = ids.filter(Boolean);
  writeAll(all);
}

/** Set ALL configured provider API keys into process.env so readSecrets() picks them up. */
export function applyAiConfigToEnv(): void {
  const config = loadAiConfig();
  for (const [id, settings] of Object.entries(config.providers)) {
    if (!settings.api_key) continue;
    const providerConfig = getProvider(id);
    if (providerConfig) {
      process.env[providerConfig.secretEnvVar] = settings.api_key;
    }
    if (settings.api_base) {
      process.env[`${id.toUpperCase().replace(/-/g, '_')}_API_BASE`] =
        settings.api_base;
    }
  }
}
