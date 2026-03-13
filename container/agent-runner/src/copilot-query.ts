/**
 * Copilot CLI query runner for container mode.
 * Spawns `copilot` CLI with appropriate flags, parses JSON output,
 * and handles the IPC message loop.
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { drainIpcInput, waitForIpcMessage } from './claude-query.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  model?: string;
  secrets?: Record<string, string>;
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
  console.error(`[copilot-runner] ${message}`);
}

/**
 * Run a single copilot CLI query. Returns session ID and status.
 */
function runCopilotQuery(
  prompt: string,
  cwd: string,
  mcpConfigPath: string,
  sessionId: string | undefined,
  model: string | undefined,
  containerInput: ContainerInput,
): Promise<{ newSessionId?: string; status: 'success' | 'error'; error?: string }> {
  return new Promise((resolve) => {
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--additional-mcp-config', `@${mcpConfigPath}`,
      '--yolo',
    ];
    if (sessionId) args.push('--resume', sessionId);
    if (model) args.push('--model', model);

    log(`Spawning copilot CLI (session: ${sessionId || 'new'})`);
    log(`copilot ${args.join(' ')}`);

    const env = { ...process.env };
    // Pass GitHub token for authentication if available
    const token = containerInput.secrets?.['GITHUB_TOKEN']
      || containerInput.secrets?.['GH_TOKEN']
      || containerInput.secrets?.['COPILOT_GITHUB_TOKEN'];
    if (token) env['GITHUB_TOKEN'] = token;

    const proc = spawn('copilot', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env,
    });

    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    let newSessionId: string | undefined;
    let hadOutput = false;
    let lineBuffer = '';

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      if (stdout.length < 512 * 1024) stdout += chunk;

      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const event = JSON.parse(trimmed);

          if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
            newSessionId = event.session_id;
            log(`Session initialized: ${newSessionId}`);
          }

          if (event.type === 'result') {
            hadOutput = true;
            writeOutput({
              status: 'success',
              result: event.result || null,
              newSessionId,
            });
          }
        } catch {
          // Not JSON — skip
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      if (stderr.length < 64 * 1024) stderr += chunk;
      for (const line of chunk.trim().split('\n')) {
        if (line) log(line);
      }
    });

    const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      log('Copilot CLI timeout, killing');
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* */ } }, 15000);
    }, TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        resolve(hadOutput
          ? { newSessionId, status: 'success' }
          : { status: 'error', error: 'Copilot CLI timed out' });
        return;
      }
      if (code !== 0) {
        log(`Copilot exited with code ${code}`);
        resolve({
          newSessionId,
          status: 'error',
          error: `Copilot exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }
      resolve({ newSessionId, status: 'success' });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      log(`Copilot spawn error: ${err.message}`);
      resolve({ status: 'error', error: `Copilot spawn error: ${err.message}` });
    });
  });
}

/**
 * Write MCP config for copilot to discover the nanoclaw IPC server.
 */
function writeMcpConfig(containerInput: ContainerInput, ipcDir: string): string {
  const mcpServerPath = path.resolve('/app/dist/ipc-mcp-stdio.js');
  const configPath = '/tmp/copilot-mcp-config.json';
  const config = {
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          NANOCLAW_IPC_DIR: ipcDir,
        },
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

/**
 * Run copilot agent inside the container.
 * Handles the IPC message loop (query → wait → query → ...).
 */
export async function runCopilotAgent(containerInput: ContainerInput): Promise<void> {
  const cwd = '/workspace/group';
  const ipcDir = '/workspace/ipc';
  const mcpConfigPath = writeMcpConfig(containerInput, ipcDir);

  let sessionId = containerInput.sessionId;
  let prompt = containerInput.prompt;

  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK]\n\n${prompt}`;
  }

  // Drain any pending IPC messages
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop
  while (true) {
    const result = await runCopilotQuery(
      prompt,
      cwd,
      mcpConfigPath,
      sessionId,
      containerInput.model || undefined,
      containerInput,
    );

    if (result.newSessionId) {
      sessionId = result.newSessionId;
    }

    if (result.status === 'error') {
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: sessionId,
        error: result.error,
      });
      process.exit(1);
    }

    // Emit session update
    writeOutput({ status: 'success', result: null, newSessionId: sessionId });

    log('Query done, waiting for IPC input');

    const nextMessage = await waitForIpcMessage();
    if (nextMessage === null) {
      log('Close sentinel received, exiting');
      break;
    }

    log(`Got IPC message (${nextMessage.length} chars), starting new query`);
    prompt = nextMessage;
  }
}
