/**
 * OpenAI-compatible agent runner for NanoClaw.
 * Provides full agentic capabilities (tool use) for non-Claude providers
 * using the OpenAI chat completions API with function calling.
 *
 * Supports: DeepSeek, Qwen, Doubao, MiniMax, Gemini, OpenAI
 * (any provider with an OpenAI-compatible API endpoint)
 */

import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { getToolDefinitions, executeTool } from './tools.js';

interface ImageAttachment {
  relativePath: string;
  mediaType: string;
}

export interface OpenAIAgentInput {
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
  imageAttachments?: ImageAttachment[];
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  error?: string;
}

type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type ConversationMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | UserContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const MAX_ITERATIONS = 50;
const HISTORY_FILE = '.agent-history.json';
const MAX_OUTPUT_TOKENS = 8192;
/** Default input token budget (conservative for 128k models). */
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
  console.error(`[openai-agent] ${message}`);
}

// --- Token estimation & compression ---

/** Rough token estimate: ~2.5 chars/token for mixed CJK/English. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

function messageText(m: ConversationMessage): string {
  if (typeof m.content === 'string') return m.content;
  if (m.content === null) return '';
  return JSON.stringify(m.content);
}

function estimateMessagesTokens(messages: ConversationMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(messageText(m)) + 4; // ~4 tokens overhead per message
  }
  return total;
}

/**
 * Compress messages to fit within a token budget.
 * Strategy: drop oldest non-system, non-latest messages first;
 * then truncate the user prompt if still over budget.
 */
function compressMessages(messages: ConversationMessage[], budget: number): ConversationMessage[] {
  let tokens = estimateMessagesTokens(messages);
  if (tokens <= budget) return messages;

  const before = messages.length;

  // Phase 1: Drop oldest messages between system (index 0) and the latest user message.
  // Preserve: system [0], the last user message, and any trailing assistant/tool messages.
  // Tool call/result pairs are removed together to avoid orphaned tool_call_ids.
  while (tokens > budget && messages.length > 2) {
    const msg = messages[1];

    // Remove an assistant with tool_calls along with its subsequent tool result messages
    if (msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls) {
      const ids = new Set(msg.tool_calls.map(tc => tc.id));
      tokens -= estimateTokens(messageText(msg)) + 4;
      messages.splice(1, 1);
      while (messages.length > 1 && messages[1].role === 'tool' && 'tool_call_id' in messages[1] && ids.has(messages[1].tool_call_id)) {
        tokens -= estimateTokens(messageText(messages[1])) + 4;
        messages.splice(1, 1);
      }
      continue;
    }

    // Remove orphaned tool result messages
    if (msg.role === 'tool') {
      tokens -= estimateTokens(messageText(msg)) + 4;
      messages.splice(1, 1);
      continue;
    }

    const removed = messages.splice(1, 1)[0];
    tokens -= estimateTokens(messageText(removed)) + 4;
  }

  // Phase 2: If still over, truncate the last user message (keep tail = most recent content).
  if (tokens > budget && messages.length >= 2) {
    const last = messages[messages.length - 1];
    if (last.role === 'user' && typeof last.content === 'string') {
      const systemTokens = estimateTokens(messageText(messages[0])) + 4;
      const availableChars = Math.floor((budget - systemTokens - 100) * 2.5);
      if (availableChars > 0 && last.content.length > availableChars) {
        last.content = '...(earlier messages truncated)\n' + last.content.slice(-availableChars);
        tokens = estimateMessagesTokens(messages);
      }
    }
  }

  log(`Compressed: ${before} → ${messages.length} messages, ~${tokens} tokens (budget: ${budget})`);
  return messages;
}

// --- History condensation (summarize old turns) ---

async function generateSummary(
  client: OpenAI,
  model: string,
  text: string,
): Promise<string> {
  try {
    const resp = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content:
            'Summarize the following conversation concisely. Keep key facts, decisions, user preferences, and pending tasks. Be brief (under 500 words).',
        },
        { role: 'user', content: text },
      ],
      max_tokens: 1024,
    });
    return resp.choices[0]?.message?.content || text.slice(0, 500);
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
  client: OpenAI,
  model: string,
  messages: ConversationMessage[],
): Promise<ConversationMessage[]> {
  if (messages.length === 0) return messages;

  // Separate system prompt from conversation
  const system = messages[0].role === 'system' ? messages[0] : null;
  const conv = system ? messages.slice(1) : [...messages];

  // Detect existing summary
  let existingSummary = '';
  let startIdx = 0;
  if (
    conv.length > 0 &&
    conv[0].role === 'user' &&
    typeof conv[0].content === 'string' &&
    conv[0].content.startsWith(SUMMARY_MARKER)
  ) {
    existingSummary = conv[0].content;
    startIdx = conv[1]?.role === 'assistant' ? 2 : 1;
  }

  // Count real user turns (string content only, not tool results)
  const turns = conv.slice(startIdx);
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

  const result: ConversationMessage[] = [];
  if (system) result.push(system);
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
  const match = errorMsg.match(/maximum context length is (\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

export async function runOpenAIAgent(input: OpenAIAgentInput): Promise<void> {
  const client = new OpenAI({
    apiKey: input.apiKey,
    baseURL: input.apiBase,
  });

  const toolDefs = getToolDefinitions();
  const systemPrompt = buildSystemPrompt(input);

  // Load or initialize conversation history
  const historyPath = path.join('/workspace/group', HISTORY_FILE);
  let messages: ConversationMessage[] = loadHistory(historyPath);

  // If no history or system prompt changed, start fresh with system message
  if (messages.length === 0 || messages[0].role !== 'system') {
    messages = [{ role: 'system', content: systemPrompt }];
  } else {
    // Update system prompt to latest
    messages[0] = { role: 'system', content: systemPrompt };
  }

  // Condense old history (summarize turns beyond the last 5)
  messages = await condenseHistory(client, input.model, messages);

  // Add user message (with optional image attachments as multimodal content)
  if (input.imageAttachments && input.imageAttachments.length > 0) {
    const parts: UserContentPart[] = [];
    for (const img of input.imageAttachments) {
      const imgPath = path.join('/workspace/group', img.relativePath);
      try {
        if (fs.existsSync(imgPath)) {
          const data = fs.readFileSync(imgPath).toString('base64');
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${img.mediaType};base64,${data}` },
          });
          log(`Loaded image: ${img.relativePath}`);
        }
      } catch (err) {
        log(`Failed to load image ${imgPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    parts.push({ type: 'text', text: input.prompt });
    messages.push({ role: 'user', content: parts });
  } else {
    messages.push({ role: 'user', content: input.prompt });
  }

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

    // Compress before each API call (handles both initial prompt and mid-loop tool accumulation)
    messages = compressMessages(messages, tokenBudget);

    log(
      `Iteration ${iteration}: sending ${messages.length} messages (~${estimateMessagesTokens(messages)} tokens) to ${input.provider}/${input.model}`,
    );

    try {
      const response = await client.chat.completions.create({
        model: input.model,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        tools: toolDefs as OpenAI.Chat.Completions.ChatCompletionTool[],
        tool_choice: 'auto',
        max_tokens: MAX_OUTPUT_TOKENS,
      });

      const choice = response.choices?.[0];
      if (!choice) {
        log(`No choices returned from API: ${JSON.stringify(response).slice(0, 300)}`);
        break;
      }

      const assistantMsg = choice.message;

      // Add assistant message to history
      messages.push({
        role: 'assistant',
        content: assistantMsg.content,
        tool_calls: assistantMsg.tool_calls,
      });

      // If there are tool calls, execute them
      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        for (const toolCall of assistantMsg.tool_calls) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            args = {};
          }

          log(
            `Tool call: ${toolCall.function.name}(${JSON.stringify(args).slice(0, 200)})`,
          );

          const result = await executeTool(toolCall.function.name, args, context);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result.output,
          });

          log(
            `Tool result (${result.isError ? 'ERROR' : 'OK'}): ${result.output.slice(0, 200)}`,
          );
        }
        // Continue loop to let model process tool results
        continue;
      }

      // No tool calls — this is the final response
      finalText = assistantMsg.content || null;
      break;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Handle orphaned tool_call_ids after compression/history truncation
      if (errorMsg.includes('tool_call_id') || errorMsg.includes('tool id') || errorMsg.includes('tool result')) {
        log(`Tool ID mismatch, cleaning orphaned tool messages: ${errorMsg}`);
        messages = messages.filter(m => {
          if (m.role === 'tool') return false;
          if (m.role === 'assistant' && 'tool_calls' in m && m.tool_calls) return false;
          return true;
        });
        iteration--;
        continue;
      }

      // Retry once with tighter budget if context length exceeded
      const modelLimit = parseContextLimit(errorMsg);
      if (modelLimit && tokenBudget >= modelLimit) {
        // Already tried with a tight budget — give up
        log(`API error (context still too large after compression): ${errorMsg}`);
        writeOutput({ status: 'error', result: null, error: errorMsg });
        saveHistory(historyPath, messages);
        return;
      }
      if (modelLimit) {
        tokenBudget = modelLimit - MAX_OUTPUT_TOKENS - 2000; // reserve output + safety
        log(`Context limit detected: ${modelLimit} tokens. Retrying with budget ${tokenBudget}`);
        iteration--; // Don't count the failed attempt
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

function buildSystemPrompt(input: OpenAIAgentInput): string {
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

  // Load per-group CLAUDE.md as context (cap at 10k chars to prevent token bloat)
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

  // Load global CLAUDE.md if available (non-main only, cap at 10k chars)
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

function loadHistory(historyPath: string): ConversationMessage[] {
  try {
    if (fs.existsSync(historyPath)) {
      const data = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      if (!Array.isArray(data)) return [];

      // Keep history compact: system message + last 12 entries
      if (data.length > 12) {
        return [data[0], ...data.slice(-12)];
      }
      return data;
    }
  } catch {
    // Corrupted file, start fresh
  }
  return [];
}

const MAX_SAVED_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 500;

function saveHistory(
  historyPath: string,
  messages: ConversationMessage[],
): void {
  try {
    // Save only system/user/assistant-text messages to keep history compact.
    // Tool calls and tool results are transient and context-specific.
    let toSave = messages.filter(
      (m) =>
        m.role === 'system' ||
        m.role === 'user' ||
        (m.role === 'assistant' && !('tool_calls' in m && m.tool_calls)),
    );

    // Truncate long message content to save tokens on future requests
    toSave = toSave.map((m) => {
      if (m.role === 'system') return m;
      const content = 'content' in m && typeof m.content === 'string' ? m.content : '';
      if (content.length > MAX_MESSAGE_LENGTH) {
        return { ...m, content: content.slice(0, MAX_MESSAGE_LENGTH) + '...' };
      }
      return m;
    });

    // Keep only system + last N messages
    if (toSave.length > MAX_SAVED_MESSAGES + 1) {
      toSave = [toSave[0], ...toSave.slice(-(MAX_SAVED_MESSAGES))];
    }

    fs.writeFileSync(historyPath, JSON.stringify(toSave));
  } catch {
    // Non-critical, ignore
  }
}
