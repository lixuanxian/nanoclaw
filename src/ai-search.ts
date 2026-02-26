/**
 * AI-powered search keyword extraction.
 * Sends a natural language query to the configured AI provider,
 * which returns optimised FTS5 search keywords.
 */
import { loadDefaultProviderConfig, type ResolvedProviderConfig } from './channel-config.js';
import { getProvider } from './providers.js';
import { logger } from './logger.js';

const SYSTEM_PROMPTS: Record<string, string> = {
  en:
    'You are a search keyword extractor. Given a user\'s natural language query, ' +
    'extract the most relevant search keywords for a full-text search database. ' +
    'Return ONLY the keywords separated by spaces, nothing else. ' +
    'Do not explain, do not wrap in tags, do not add any other text.',
  'zh-CN':
    '你是搜索关键词提取器。根据用户的自然语言查询，' +
    '提取最相关的全文搜索关键词。' +
    '只返回用空格分隔的关键词，不要返回任何其他内容。' +
    '不要解释，不要包裹在标签中，不要添加任何其他文本。',
};

/** Strip <think>...</think> blocks that some models (e.g. DeepSeek) include. */
function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Use the configured AI provider to extract search keywords from a natural language query.
 * On failure, returns the original query as keywords so FTS5 still gets something useful.
 */
export async function extractSearchKeywords(
  query: string,
  lang = 'en',
): Promise<{ keywords: string; error?: string }> {
  const config = loadDefaultProviderConfig();

  if (!config.provider) {
    return { keywords: query, error: 'No AI provider configured' };
  }

  // Get API key: prefer settings page, fall back to env var
  const providerDef = getProvider(config.provider);
  const apiKey =
    config.api_key || (providerDef ? process.env[providerDef.secretEnvVar] : '') || '';

  if (!apiKey) {
    return { keywords: query, error: 'API key not configured' };
  }

  const systemPrompt = SYSTEM_PROMPTS[lang] || SYSTEM_PROMPTS.en;

  try {
    if (config.provider === 'claude' || config.provider === 'claude-compatible') {
      return await callAnthropic(apiKey, config, query, systemPrompt);
    }
    return await callOpenAI(apiKey, config, query, systemPrompt);
  } catch (err) {
    logger.warn({ err, provider: config.provider }, 'AI keyword extraction failed');
    return { keywords: query, error: err instanceof Error ? err.message : 'AI extraction failed' };
  }
}

async function callAnthropic(
  apiKey: string,
  config: ResolvedProviderConfig,
  query: string,
  systemPrompt: string,
): Promise<{ keywords: string }> {
  const apiBase = config.api_base || 'https://api.anthropic.com';
  const model = config.model || 'claude-sonnet-4-6';

  const res = await fetch(`${apiBase}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 100,
      system: systemPrompt,
      messages: [{ role: 'user', content: query }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { content: Array<{ type: string; text: string }> };
  const text = data.content?.find((c) => c.type === 'text')?.text || query;
  return { keywords: stripThinkTags(text) };
}

async function callOpenAI(
  apiKey: string,
  config: ResolvedProviderConfig,
  query: string,
  systemPrompt: string,
): Promise<{ keywords: string }> {
  const apiBase = config.api_base || 'https://api.openai.com/v1';
  const model = config.model || 'gpt-4o-mini';

  const res = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 100,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const text = data.choices?.[0]?.message?.content || query;
  return { keywords: stripThinkTags(text) };
}
