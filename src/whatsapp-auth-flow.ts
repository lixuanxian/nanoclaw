/**
 * Reusable WhatsApp authentication flow.
 * Manages the Baileys connection + QR code lifecycle so both the CLI
 * (whatsapp-auth.ts) and the web settings UI can drive the same process.
 */
import fs from 'fs';
import pino from 'pino';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

const AUTH_DIR = './store/auth';

export type AuthStatus =
  | 'idle'
  | 'connecting'
  | 'qr_ready'
  | 'authenticated'
  | 'already_authenticated'
  | 'failed';

export interface AuthState {
  status: AuthStatus;
  qr?: string;
  error?: string;
}

export class WhatsAppAuthFlow {
  private state: AuthState = { status: 'idle' };
  private socket: ReturnType<typeof makeWASocket> | null = null;
  private logger = pino({ level: 'warn' });

  getState(): AuthState {
    return { ...this.state };
  }

  /**
   * Start the authentication flow.
   * Resolves when auth succeeds or fails (or call stop() to abort).
   */
  async start(): Promise<AuthState> {
    if (
      this.state.status === 'connecting' ||
      this.state.status === 'qr_ready'
    ) {
      return this.state;
    }

    fs.mkdirSync(AUTH_DIR, { recursive: true });
    this.state = { status: 'connecting' };

    return this.connect(false);
  }

  stop(): void {
    if (this.socket) {
      try {
        this.socket.end(undefined);
      } catch {
        // ignore
      }
      this.socket = null;
    }
    this.state = { status: 'idle' };
  }

  private async connect(isReconnect: boolean): Promise<AuthState> {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    if (state.creds.registered && !isReconnect) {
      this.state = { status: 'already_authenticated' };
      return this.state;
    }

    const { version } = await fetchLatestWaWebVersion({}).catch(() => ({
      version: undefined,
    }));

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger),
      },
      printQRInTerminal: false,
      logger: this.logger,
      browser: Browsers.macOS('Chrome'),
    });

    this.socket = sock;

    return new Promise<AuthState>((resolve) => {
      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.state = { status: 'qr_ready', qr };
        }

        if (connection === 'close') {
          const reason = (lastDisconnect?.error as any)?.output?.statusCode;

          if (reason === 515) {
            // Stream error after pairing — reconnect to finish handshake
            this.connect(true).then(resolve);
            return;
          }

          const errorMap: Record<number, string> = {
            [DisconnectReason.loggedOut]:
              'Logged out. Delete store/auth and try again.',
            [DisconnectReason.timedOut]: 'QR code timed out. Please try again.',
          };

          this.state = {
            status: 'failed',
            error:
              errorMap[reason] ||
              `Connection failed (reason: ${reason || 'unknown'})`,
          };
          this.socket = null;
          resolve(this.state);
        }

        if (connection === 'open') {
          this.state = { status: 'authenticated' };
          this.socket = null;
          // Give credentials time to save
          setTimeout(() => resolve(this.state), 500);
        }
      });

      sock.ev.on('creds.update', saveCreds);
    });
  }
}

/** Singleton for web-server use — one auth flow at a time. */
let _instance: WhatsAppAuthFlow | null = null;

export function getAuthFlow(): WhatsAppAuthFlow {
  if (!_instance) {
    _instance = new WhatsAppAuthFlow();
  }
  return _instance;
}
