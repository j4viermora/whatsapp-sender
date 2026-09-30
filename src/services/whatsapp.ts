import path from 'node:path';
import qrcode from 'qrcode-terminal';
import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import type { Status } from '../types';

/**
 * A WhatsApp Web session. `down` is set when WhatsApp reports a disconnection,
 * so the next send knows it has to reconnect. `client` is null if reconnecting failed.
 */
export interface Session {
  client: Client | null;
  down?: string;
}

// Saved WhatsApp login, at the project root
const AUTH_PATH = path.join(import.meta.dir, '..', '..', '.wwebjs_auth');

// Errors meaning the WhatsApp Web page was lost (not a problem with the number)
export function connectionLost(message: string): boolean {
  return /detached Frame|Session closed|Target closed|Protocol error|Execution context was destroyed|WhatsApp se desconectó/i.test(
    message
  );
}

// Opens WhatsApp Web and waits until it's ready. If WhatsApp reports a disconnection,
// it's stored in session.down so the next send reconnects.
// With `timeoutMs` it fails if it doesn't connect in time (for unattended reconnects).
// `log` prints the QR instructions without breaking the caller's terminal output.
export function connect(log: (msg: string) => void, timeoutMs?: number): Promise<Session> {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_PATH }),
    puppeteer: { headless: true },
  });
  const session: Session = { client };
  client.on('qr', (qr: string) => {
    log('Escaneá este QR desde WhatsApp > Dispositivos vinculados:');
    qrcode.generate(qr, { small: true });
  });
  client.on('disconnected', (reason) => {
    session.down = String(reason || 'desconectado');
  });

  return new Promise<Session>((resolve, reject) => {
    const timer =
      timeoutMs !== undefined
        ? setTimeout(() => {
            void close(client);
            reject(new Error(`WhatsApp no respondió en ${timeoutMs / 60000} minutos`));
          }, timeoutMs)
        : undefined;
    client.once('ready', () => {
      clearTimeout(timer);
      resolve(session);
    });
    client.once('auth_failure', (message: string) => {
      clearTimeout(timer);
      void close(client);
      reject(new Error(`Error de autenticación: ${message}`));
    });
    client.initialize().catch((e: unknown) => {
      clearTimeout(timer);
      void close(client);
      reject(e);
    });
  });
}

export async function close(client: Client | null): Promise<void> {
  try {
    await client?.destroy();
  } catch {
    // If the page was already broken, destroy can fail too: doesn't matter
  }
}

// Sends `text` to `phone` (as the caption if there's an attachment).
// Throws if the session is down or the send fails.
export async function sendMessage(
  session: Session,
  phone: string,
  text: string,
  attachment: string | null
): Promise<Exclude<Status, 'error'>> {
  if (session.down || !session.client) throw new Error(`WhatsApp se desconectó (${session.down})`);
  const client = session.client;
  const id = await client.getNumberId(phone);
  if (!id) return 'sin_whatsapp';

  if (attachment) {
    await client.sendMessage(id._serialized, MessageMedia.fromFilePath(attachment), { caption: text });
  } else {
    await client.sendMessage(id._serialized, text);
  }
  return 'enviado';
}
