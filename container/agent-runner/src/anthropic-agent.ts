/**
 * Anthropic-compatible agent runner for NanoClaw.
 * Uses the raw Anthropic Messages API (no extended thinking)
 * for claude-compatible proxy endpoints.
 *
 * This avoids the thinking block signature issues that occur
 * when using the Claude Agent SDK through third-party proxies.
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { getToolDefinitions, executeTool } from './tools.js';

export interface AnthropicAgentInput {
  prompt: string;
  provider: string;
  model: string;
  apiBase: string;
  apiKey: string;
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  error?: string;
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const MAX_ITERATIONS = 50;
const HISTORY_FILE = '.agent-history-anthropic.json';
const MAX_OUTPUT_TOKENS = 8192;
/** Default input token budget (conservative for 128k+ models). */
const DEFAULT_TOKEN_BUDGET = 100_000;
/** Max conversation turns before summarization. */
const SUMMARY_TURN_THRESHOLD = 5;
/** Max estimated history tokens before summarization. */
const SUMMARY_TOKEN_THRESHOLD = 8000;
const SUMMARY_MARKER = '[Conversation Summary]';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[anthropic-agent] ${message}`);
}

// Convert OpenAI-format tool definitions to Anthropic format
function getAnthropicTools(): Anthropic.Messages.Tool[] {
  return getToolDefinitions().map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as Anthropic.Messages.Tool.InputSchema,
  }));
}

type MessageParam = Anthropic.Messages.MessageParam;

// --- Token estimation & compression ---

/** Rough token estimate: ~2.5 chars/token for mixed CJK/English. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

function messageText(m: MessageParam): string {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return JSON.stringify(m.content);
  return '';
}

function estimateMessagesTokens(messages: MessageParam[], systemPrompt?: string): number {
  let total = systemPrompt ? estimateTokens(systemPrompt) + 4 : 0;
  for (const m of messages) {
    total += estimateTokens(messageText(m)) + 4;
  }
  return total;
}

/**
 * Compress messages to fit within a token budget.
 * Drops oldest messages first; truncates the latest user prompt if still over.
 */
function compressMessages(messages: MessageParam[], budget: number, systemPrompt: string): MessageParam[] {
  let tokens = estimateMessagesTokens(messages, systemPrompt);
  if (tokens <= budget) return messages;

  const before = messages.length;

  // Phase 1: Drop oldest messages (keep the latest user message + trailing)
  while (tokens > budget && messages.length > 1) {
    const removed = messages.shift()!;
    tokens -= estimateTokens(messageText(removed)) + 4;
  }

  // Phase 2: Truncate the remaining user message if still over
  if (tokens > budget && messages.length >= 1) {
    const first = messages[0];
    if (first.role === 'user' && typeof first.content === 'string') {
      const systemTokens = estimateTokens(systemPrompt) + 4;
      const availableChars = Math.floor((budget - systemTokens - 100) * 2.5);
      if (availableChars > 0 && first.content.length > availableChars) {
        first.content = '...(earlier messages truncated)\n' + first.content.slice(-availableChars);
        tokens = estimateMessagesTokens(messages, systemPrompt);
      }
    }
  }

  log(`Compressed: ${before} → ${messages.length} messages, ~${tokens} tokens (budget: ${budget})`);
  return messages;
}

// --- History condensation (summarize old turns) ---

async function generateSummary(
  client: Anthropic,
  model: string,
  text: string,
): Promise<string> {
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: 1024,
      system:
        'Summarize the following conversation concisely. Keep key facts, decisions, user preferences, and pending tasks. Be brief (under 500 words).',
      messages: [{ role: 'user', content: text }],
    });
    const block = resp.content.find((b) => b.type === 'text');
    return (block as { text: string })?.text || text.slice(0, 500);
  } catch (err) {
    log(`Summary generation failed: ${err}`);
    return text.slice(0, 500) + '...(summary failed, truncated)';
  }
}

/**
 * Condense history by summarizing old turns.
 * Keeps the last SUMMARY_TURN_THRESHOLD user turns in full;
 * older turns (+ any existing summary) are compressed into a single summary.
 */
async function condenseHistory(
  client: Anthropic,
  model: string,
  messages: MessageParam[],
): Promise<MessageParam[]> {
  if (messages.length === 0) return messages;

  // Detect existing summary
  let existingSummary = '';
  let startIdx = 0;
  if (
    messages[0].role === 'user' &&
    typeof messages[0].content === 'string' &&
    messages[0].content.startsWith(SUMMARY_MARKER)
  ) {
    existingSummary = messages[0].content;
    startIdx = messages[1]?.role === 'assistant' ? 2 : 1;
  }

  // Count real user turns (string content only, not tool results)
  const turns = messages.slice(startIdx);
  const userTurnIndices: number[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role === 'user' && typeof turns[i].content === 'string') {
      userTurnIndices.push(i);
    }
  }

  const turnCount = userTurnIndices.length;
  const historyTokens = estimateMessagesTokens(turns);

  if (turnCount <= SUMMARY_TURN_THRESHOLD && historyTokens <= SUMMARY_TOKEN_THRESHOLD) {
    return messages;
  }

  // Split: keep last N turns from the Nth-last user message onward
  const keepFrom =
    turnCount > SUMMARY_TURN_THRESHOLD
      ? userTurnIndices[turnCount - SUMMARY_TURN_THRESHOLD]
      : 0;
  const oldMsgs = turns.slice(0, keepFrom);
  const recentMsgs = turns.slice(keepFrom);

  if (oldMsgs.length === 0) return messages;

  // Build text to summarize (include existing summary for cumulative condensation)
  const toSummarize =
    (existingSummary ? existingSummary + '\n\n' : '') +
    oldMsgs.map((m) => `${m.role}: ${messageText(m)}`).join('\n');

  const summaryText = await generateSummary(client, model, toSummarize);

  const result: MessageParam[] = [];
  result.push({ role: 'user', content: SUMMARY_MARKER + '\n' + summaryText });
  result.push({
    role: 'assistant',
    content: 'Understood, I have the conversation context.',
  });
  result.push(...recentMsgs);

  log(
    `Condensed history: ${turnCount} turns → summary + ${Math.min(turnCount, SUMMARY_TURN_THRESHOLD)} recent turns (~${estimateMessagesTokens(result)} tokens)`,
  );
  return result;
}

/** Try to parse model's max context length from an API error message. */
function parseContextLimit(errorMsg: string): number | null {
  const match = errorMsg.match(/maximum context length is (\d+)/i)
    || errorMsg.match(/(\d+) tokens? (?:allowed|limit|maximum)/i);
  return match ? parseInt(match[1], 10) : null;
}

export async function runAnthropicAgent(input: AnthropicAgentInput): Promise<void> {
  const client = new Anthropic({
    apiKey: input.apiKey,
    baseURL: input.apiBase || undefined,
  });

  const tools = getAnthropicTools();
  const systemPrompt = buildSystemPrompt(input);

  // Load or initialize conversation history
  const historyPath = path.join('/workspace/group', HISTORY_FILE);
  let messages: MessageParam[] = loadHistory(historyPath);

  // Condense old history (summarize turns beyond the last 5)
  messages = await condenseHistory(client, input.model, messages);

  // Add user message
  messages.push({ role: 'user', content: input.prompt });

  const context = {
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain,
  };

  let tokenBudget = DEFAULT_TOKEN_BUDGET;
  let iteration = 0;
  let finalText: string | null = null;

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    // Compress before each API call
    messages = compressMessages(messages, tokenBudget, systemPrompt);

    log(`Iteration ${iteration}: sending ${messages.length} messages (~${estimateMessagesTokens(messages, systemPrompt)} tokens) to ${input.provider}/${input.model}`);

    try {
      const response = await client.messages.create({
        model: input.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt,
        messages,
        tools,
      });

      // Collect text and tool_use blocks from the response
      const textParts: string[] = [];
      const toolUseBlocks: Anthropic.Messages.ToolUseBlock[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push(block);
        }
      }

      // Add assistant message to history
      messages.push({ role: 'assistant', content: response.content });

      // If there are tool calls, execute them
      if (toolUseBlocks.length > 0) {
        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

        for (const toolUse of toolUseBlocks) {
          const args = (toolUse.input || {}) as Record<string, unknown>;
          log(`Tool call: ${toolUse.name}(${JSON.stringify(args).slice(0, 200)})`);

          const result = await executeTool(toolUse.name, args, context);

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result.output,
            is_error: result.isError || false,
          });

          log(`Tool result (${result.isError ? 'ERROR' : 'OK'}): ${result.output.slice(0, 200)}`);
        }

        // Add tool results as a user message
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // No tool calls — this is the final response
      finalText = textParts.join('\n') || null;
      break;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Retry once with tighter budget if context length exceeded
      const modelLimit = parseContextLimit(errorMsg);
      if (modelLimit && tokenBudget >= modelLimit) {
        log(`API error (context still too large after compression): ${errorMsg}`);
        writeOutput({ status: 'error', result: null, error: errorMsg });
        saveHistory(historyPath, messages);
        return;
      }
      if (modelLimit) {
        tokenBudget = modelLimit - MAX_OUTPUT_TOKENS - 2000;
        log(`Context limit detected: ${modelLimit} tokens. Retrying with budget ${tokenBudget}`);
        iteration--;
        continue;
      }

      log(`API error: ${errorMsg}`);
      writeOutput({ status: 'error', result: null, error: errorMsg });
      saveHistory(historyPath, messages);
      return;
    }
  }

  if (iteration >= MAX_ITERATIONS) {
    log(`Hit max iterations (${MAX_ITERATIONS})`);
  }

  // Save history for session continuity
  saveHistory(historyPath, messages);

  // Emit result
  writeOutput({ status: 'success', result: finalText });
}

function buildSystemPrompt(input: AnthropicAgentInput): string {
  const parts: string[] = [];

  parts.push(
    `You are ${input.assistantName || 'Andy'}, a helpful AI assistant running inside a Linux container.`,
  );
  parts.push(
    'You have access to tools for shell commands, file operations, web fetching, and messaging.',
  );
  parts.push(
    'Your working directory is /workspace/group. Use absolute paths when possible.',
  );
  parts.push('');
  parts.push('Today is ' + new Date().toISOString().split('T')[0] + '.');
  parts.push('');

  // Load per-group CLAUDE.md (cap at 10k chars)
  const claudeMdPath = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(claudeMdPath)) {
    try {
      let claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
      if (claudeMd.length > 10000) {
        claudeMd = claudeMd.slice(0, 10000) + '\n...(truncated)';
      }
      parts.push('## Group Memory\n');
      parts.push(claudeMd);
      parts.push('');
    } catch {
      // Ignore read errors
    }
  }

  // Load global CLAUDE.md (non-main only, cap at 10k chars)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  if (!input.isMain && fs.existsSync(globalClaudeMdPath)) {
    try {
      let globalMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
      if (globalMd.length > 10000) {
        globalMd = globalMd.slice(0, 10000) + '\n...(truncated)';
      }
      parts.push('## Global Context\n');
      parts.push(globalMd);
      parts.push('');
    } catch {
      // Ignore read errors
    }
  }

  if (input.isScheduledTask) {
    parts.push(
      'This is a scheduled task. Use the send_message tool if you need to communicate results to the user.',
    );
  }

  return parts.join('\n');
}

function loadHistory(historyPath: string): MessageParam[] {
  try {
    if (fs.existsSync(historyPath)) {
      const data = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      if (!Array.isArray(data)) return [];

      if (data.length > 12) {
        return data.slice(-12);
      }
      return data;
    }
  } catch {
    // Corrupted file, start fresh
  }
  return [];
}

function saveHistory(historyPath: string, messages: MessageParam[]): void {
  try {
    // Save only user-text and assistant-text messages to keep history compact.
    const toSave = messages.filter((m) => {
      if (m.role === 'user' && typeof m.content === 'string') return true;
      if (m.role === 'assistant') {
        // Only save if it has text content (no tool_use blocks)
        if (typeof m.content === 'string') return true;
        if (Array.isArray(m.content)) {
          return m.content.every((b) => 'type' in b && b.type === 'text');
        }
      }
      return false;
    });
    fs.writeFileSync(historyPath, JSON.stringify(toSave, null, 2));
  } catch {
    // Non-critical, ignore
  }
}
