/**
 * CLI Runner for NanoClaw
 * Spawns a local coding-agent CLI (Claude or GitHub Copilot) instead of a Docker container.
 * Used when provider is 'claude' or 'copilot' and the respective CLI is available on the host.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { ContainerInput, ContainerOutput } from './container-runner.js';
import { RegisteredGroup } from './types.js';

const IPC_POLL_MS = 500;

/** Check for _close sentinel in IPC input dir. */
function shouldClose(inputDir: string): boolean {
  const sentinel = path.join(inputDir, '_close');
  if (fs.existsSync(sentinel)) {
    try {
      fs.unlinkSync(sentinel);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/** Drain pending IPC input messages. */
function drainIpcInput(inputDir: string): string[] {
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    const files = fs
      .readdirSync(inputDir)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(inputDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch {
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch {
    return [];
  }
}

/** Wait for IPC input or _close sentinel. Returns message text or null. */
function waitForIpcMessage(inputDir: string): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose(inputDir)) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput(inputDir);
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/** Write MCP config JSON for the CLI to discover the nanoclaw IPC server. */
function writeMcpConfig(
  group: RegisteredGroup,
  input: ContainerInput,
  ipcDir: string,
): string {
  const sessionsDir = path.join(DATA_DIR, 'sessions', group.folder);
  fs.mkdirSync(sessionsDir, { recursive: true });

  const mcpServerPath = path.resolve(
    process.cwd(),
    'container',
    'agent-runner',
    'src',
    'ipc-mcp-stdio.ts',
  );

  const configPath = path.join(sessionsDir, 'cli-mcp-config.json');
  const config = {
    mcpServers: {
      nanoclaw: {
        command: 'npx',
        args: ['tsx', mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: input.chatJid,
          NANOCLAW_GROUP_FOLDER: input.groupFolder,
          NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
          NANOCLAW_IPC_DIR: ipcDir,
        },
      },
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

/** CLI profile — encapsulates command name and flag differences between CLIs. */
interface CliProfile {
  command: string;
  buildArgs: (
    prompt: string,
    cwd: string,
    mcpConfigPath: string,
    sessionId?: string,
    model?: string,
  ) => string[];
}

const CLI_PROFILES: Record<string, CliProfile> = {
  claude: {
    command: process.env.NANOCLAW_CLAUDE_CMD || 'claude',
    buildArgs: (prompt, cwd, mcpConfigPath, sessionId, model) => {
      const args = [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '-c',
        cwd,
        '--mcp-config',
        mcpConfigPath,
        '--permission-mode',
        'bypassPermissions',
      ];
      if (sessionId) args.push('--resume', sessionId);
      if (model) args.push('--model', model);
      return args;
    },
  },
  copilot: {
    command: 'copilot',
    buildArgs: (prompt, _cwd, mcpConfigPath, sessionId, model) => {
      const args = [
        '-p',
        prompt,
        '--output-format',
        'json',
        '--additional-mcp-config',
        `@${mcpConfigPath}`,
        '--yolo',
      ];
      if (sessionId) args.push('--resume', sessionId);
      if (model) args.push('--model', model);
      return args;
    },
  },
};

/** Resolve CLI profile for a provider. Falls back to claude. */
function getCliProfile(provider: string): CliProfile {
  return CLI_PROFILES[provider] || CLI_PROFILES.claude;
}

/**
 * Run a single CLI query, parse JSONL output.
 * Returns session ID and result text.
 */
function runCliQuery(
  profile: CliProfile,
  prompt: string,
  cwd: string,
  mcpConfigPath: string,
  sessionId: string | undefined,
  model: string | undefined,
  group: RegisteredGroup,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  timeoutMs?: number,
): Promise<{
  newSessionId?: string;
  status: 'success' | 'error';
  error?: string;
}> {
  return new Promise((resolve) => {
    const cliArgs = profile.buildArgs(
      prompt,
      cwd,
      mcpConfigPath,
      sessionId,
      model,
    );
    const cliName = `cli-${group.folder.replace(/[^a-zA-Z0-9-]/g, '-')}-${Date.now()}`;

    logger.info(
      { group: group.name, cliName, cwd, hasSession: !!sessionId },
      'Spawning CLI agent',
    );
    logger.debug(
      { cliArgs: [profile.command, ...cliArgs].join(' ') },
      'CLI command',
    );

    const proc = spawn(profile.command, cliArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      shell: process.platform === 'win32',
    });

    onProcess(proc, cliName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let newSessionId: string | undefined;
    let hadOutput = false;
    let outputChain = Promise.resolve();

    // Close stdin immediately — prompt is passed via -p flag
    proc.stdin.end();

    // Parse stream-json: one JSON object per line
    let lineBuffer = '';
    proc.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
        } else {
          stdout += chunk;
        }
      }

      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const event = JSON.parse(trimmed);

          // Capture session ID from init event
          if (
            event.type === 'system' &&
            event.subtype === 'init' &&
            event.session_id
          ) {
            newSessionId = event.session_id;
            logger.debug(
              { sessionId: newSessionId },
              'CLI session initialized',
            );
          }

          // Emit result events
          if (event.type === 'result') {
            hadOutput = true;
            resetTimeout();
            const result: ContainerOutput = {
              status: 'success',
              result: event.result || null,
              newSessionId,
            };
            if (onOutput) {
              outputChain = outputChain.then(() => onOutput(result));
            }
          }
        } catch {
          // Not JSON — skip (could be debug output)
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ cli: group.folder }, line);
      }
      if (stderr.length < CONTAINER_MAX_OUTPUT_SIZE) {
        stderr += chunk;
      }
    });

    let timedOut = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const effectiveTimeout = Math.max(
      timeoutMs || configTimeout,
      IDLE_TIMEOUT + 30_000,
    );

    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, cliName }, 'CLI timeout, killing');
      proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, 15000);
    };

    let timeout = setTimeout(killOnTimeout, effectiveTimeout);
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, effectiveTimeout);
    };

    proc.on('close', (code) => {
      clearTimeout(timeout);

      if (timedOut) {
        if (hadOutput) {
          outputChain.then(() => resolve({ newSessionId, status: 'success' }));
        } else {
          resolve({
            status: 'error',
            error: `CLI timed out after ${configTimeout}ms`,
          });
        }
        return;
      }

      if (code !== 0) {
        logger.error(
          { group: group.name, code, stderr: stderr.slice(-500) },
          'CLI exited with error',
        );
        resolve({
          newSessionId,
          status: 'error',
          error: `CLI exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      outputChain.then(() => {
        resolve({ newSessionId, status: 'success' });
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, error: err }, 'CLI spawn error');
      resolve({
        status: 'error',
        error: `CLI spawn error: ${err.message}`,
      });
    });
  });
}

/**
 * Run agent via local CLI (Claude or Copilot).
 * Same interface as runContainerAgent — drop-in replacement.
 */
export async function runCliAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const profile = getCliProfile(input.provider || 'claude');
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const ipcDir = resolveGroupIpcPath(group.folder);
  const inputDir = path.join(ipcDir, 'input');
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(inputDir, { recursive: true });

  // Clean up stale _close sentinel
  try {
    fs.unlinkSync(path.join(inputDir, '_close'));
  } catch {
    /* ignore */
  }

  const cwd = input.isMain ? process.cwd() : groupDir;
  const mcpConfigPath = writeMcpConfig(group, input, ipcDir);

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  let sessionId = input.sessionId;
  let prompt = input.prompt;

  // Drain any pending IPC messages into the initial prompt
  const pending = drainIpcInput(inputDir);
  if (pending.length > 0) {
    logger.debug(
      { folder: group.folder, count: pending.length },
      'Draining pending IPC messages into CLI prompt',
    );
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run CLI → wait for IPC message → run again
  while (true) {
    const result = await runCliQuery(
      profile,
      prompt,
      cwd,
      mcpConfigPath,
      sessionId,
      input.model,
      group,
      onProcess,
      onOutput,
    );

    if (result.newSessionId) {
      sessionId = result.newSessionId;
    }

    if (result.status === 'error') {
      return {
        status: 'error',
        result: null,
        newSessionId: sessionId,
        error: result.error,
      };
    }

    // Emit session update marker so host can track session ID
    if (onOutput) {
      await onOutput({
        status: 'success',
        result: null,
        newSessionId: sessionId,
      });
    }

    logger.debug(
      { folder: group.folder },
      'CLI query done, waiting for IPC input',
    );

    // Wait for follow-up message or _close
    const nextMessage = await waitForIpcMessage(inputDir);
    if (nextMessage === null) {
      logger.debug(
        { folder: group.folder },
        'Close sentinel received, CLI loop ending',
      );
      break;
    }

    logger.debug(
      { folder: group.folder, length: nextMessage.length },
      'Got IPC message, starting new CLI query',
    );
    prompt = nextMessage;
  }

  // Write log
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logsDir, `cli-${timestamp}.log`);
  fs.writeFileSync(
    logFile,
    [
      '=== CLI Agent Log ===',
      `Timestamp: ${new Date().toISOString()}`,
      `Group: ${group.name}`,
      `Session: ${sessionId || 'none'}`,
      `CWD: ${cwd}`,
    ].join('\n'),
  );

  return {
    status: 'success',
    result: null,
    newSessionId: sessionId,
  };
}
