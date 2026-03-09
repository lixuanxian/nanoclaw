/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runOpenAIAgent } from './openai-agent.js';
import { runAnthropicAgent } from './anthropic-agent.js';
import { drainIpcInput, runQuery, waitForIpcMessage } from './claude-query.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  provider?: string;
  model?: string;
  providerApiBase?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Provider routing
  const provider = containerInput.provider || 'claude';

  // OpenAI-compatible providers (non-Claude, non-Claude-compatible)
  if (provider !== 'claude' && provider !== 'claude-compatible') {
    const SECRET_KEY_MAP: Record<string, string> = {
      deepseek: 'DEEPSEEK_API_KEY',
      qwen: 'QWEN_API_KEY',
      doubao: 'DOUBAO_API_KEY',
      minimax: 'MINIMAX_API_KEY',
      'openai-compatible': 'OPENAI_API_KEY',
    };
    const secretKey = SECRET_KEY_MAP[provider];
    let apiKey = secretKey ? containerInput.secrets?.[secretKey] : undefined;

    // Fallback: search all secrets for any non-empty API key matching the provider
    if (!apiKey && containerInput.secrets) {
      const upperProvider = provider.toUpperCase().replace(/-/g, '_');
      const candidateKey = `${upperProvider}_API_KEY`;
      apiKey = containerInput.secrets[candidateKey];
    }

    if (!apiKey) {
      writeOutput({
        status: 'error',
        result: `No API key configured for provider "${provider}". Please set the API key in Settings → AI Model.`,
        error: `No API key found for provider "${provider}". Set ${secretKey || 'the provider API key'} in .env or Settings`,
      });
      process.exit(1);
    }

    let prompt = containerInput.prompt;
    if (containerInput.isScheduledTask) {
      prompt = `[SCHEDULED TASK]\n\n${prompt}`;
    }

    await runOpenAIAgent({
      prompt,
      provider,
      model: containerInput.model || '',
      apiBase: containerInput.providerApiBase || '',
      apiKey,
      chatJid: containerInput.chatJid,
      groupFolder: containerInput.groupFolder,
      isMain: containerInput.isMain,
      isScheduledTask: containerInput.isScheduledTask,
      assistantName: containerInput.assistantName,
    });
    return;
  }

  // Claude and Claude-compatible providers use the Claude Agent SDK.
  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  if (provider === 'claude-compatible') {
    const apiKey = containerInput.secrets?.['CLAUDE_COMPATIBLE_API_KEY'];
    if (!apiKey) {
      writeOutput({
        status: 'error',
        result: 'No API key configured for Claude Compatible provider. Please set the API key in Settings → AI Model.',
        error: 'No API key found for provider "claude-compatible". Set CLAUDE_COMPATIBLE_API_KEY in .env or Settings',
      });
      process.exit(1);
    }
    // Override SDK auth: use the user's API key instead of OAuth
    sdkEnv['ANTHROPIC_API_KEY'] = apiKey;
    // Remove OAuth token so the SDK doesn't prefer it over the API key
    delete sdkEnv['CLAUDE_CODE_OAUTH_TOKEN'];
    // Set custom base URL if configured
    if (containerInput.providerApiBase) {
      sdkEnv['ANTHROPIC_BASE_URL'] = containerInput.providerApiBase;
    }
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query -> wait for IPC message -> run new query -> repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      let queryResult;
      try {
        queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
      } catch (queryErr) {
        // Handle orphaned tool_result IDs after compaction/truncation.
        // The API rejects tool_result blocks whose tool_use_id no longer
        // exists in the conversation history (error 2013 / "tool id ... not found").
        const msg = queryErr instanceof Error ? queryErr.message : String(queryErr);
        if (msg.includes('tool_use_id') || msg.includes('tool id') || msg.includes('tool result')) {
          log(`Tool ID mismatch during resume, retrying with fresh session: ${msg}`);
          sessionId = undefined;
          resumeAt = undefined;
          queryResult = await runQuery(prompt, undefined, mcpServerPath, containerInput, sdkEnv);
        } else {
          throw queryErr;
        }
      }

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
