import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import qrcode from 'qrcode-terminal';
import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import baseConfig, { type Config } from './config';

// Paths in config.ts are relative to this folder, not to where the script is run from
const cfg: Config = {
  ...baseConfig,
  contacts: path.resolve(import.meta.dir, baseConfig.contacts),
  template: path.resolve(import.meta.dir, baseConfig.template),
  log: path.resolve(import.meta.dir, baseConfig.log),
};

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_RECONNECTS = 5;

/** A spreadsheet row, keyed by normalized column name */
type Row = Record<string, unknown>;

/** Status written to the log. The values stay in Spanish so existing logs keep working. */
type Status = 'enviado' | 'sin_whatsapp' | 'error';

interface Pending {
  row: Row;
  phone: string;
}

/**
 * A WhatsApp Web session. `down` is set when WhatsApp reports a disconnection,
 * so the next send knows it has to reconnect. `client` is null if reconnecting failed.
 */
interface Session {
  client: Client | null;
  down?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const clock = (): string => new Date().toLocaleTimeString('es-AR');
// Column names without case or accents: "Teléfono" and "telefono" are the same column
const normCol = (s: unknown): string =>
  String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Progress bar on the last terminal line (only in an interactive terminal)
const TTY = process.stdout.isTTY;
const counts: Record<Status, number> = { enviado: 0, sin_whatsapp: 0, error: 0 };

function duration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 1) return `${Math.round(sec)}s`;
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}min`;
}

const countdown = (sec: number): string => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

const visibleLength = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, '').length;

function showBar(done: number, total: number, extra = ''): void {
  if (!TTY) return;
  const pct = Math.round((done / total) * 100);
  let remaining = (total - done) * ((cfg.minDelay + cfg.maxDelay) / 2 + 3);
  if (cfg.batchSize > 0) {
    remaining += Math.floor((total - done) / cfg.batchSize) * ((cfg.minBreak + cfg.maxBreak) / 2) * 60;
  }
  const parts = {
    count: `${done}/${total} (${pct}%)`,
    stats: `\x1b[32m✓ ${counts.enviado}\x1b[0m  \x1b[33m⊘ ${counts.sin_whatsapp}\x1b[0m  \x1b[31m✗ ${counts.error}\x1b[0m`,
    eta: done < total ? `~${duration(remaining)} restantes` : '',
    extra,
  };
  // The line must never exceed the terminal width: if it wraps, every update leaves
  // a new line behind. If it doesn't fit, data is dropped in this order.
  const cols = (process.stdout.columns || 80) - 1;
  const text = (): string => Object.values(parts).filter(Boolean).join('  ');
  for (const k of ['eta', 'stats', 'extra'] as const) {
    if (visibleLength(text()) + 6 <= cols) break;
    parts[k] = '';
  }
  const width = Math.max(0, Math.min(25, cols - visibleLength(text()) - 1));
  const filled = Math.round((done / total) * width);
  const bar = width ? '\x1b[32m' + '█'.repeat(filled) + '\x1b[90m' + '░'.repeat(width - filled) + '\x1b[0m ' : '';
  process.stdout.write(`\r\x1b[K${bar}${text()}`);
}

// Prints a normal line without overwriting the bar
function log(msg: string): void {
  if (TTY) process.stdout.write('\r\x1b[K');
  console.log(msg);
}

function normalizePhone(value: unknown): string | null {
  let t = String(value ?? '').replace(/\D/g, '');
  if (!t) return null;
  if (t.startsWith('00')) t = t.slice(2);
  if (t.startsWith('0')) t = t.slice(1);
  if (!t.startsWith(cfg.countryCode)) t = cfg.countryCode + t;
  // Argentina: mobile numbers on WhatsApp have a 9 after the 54
  if (cfg.countryCode === '54' && !t.startsWith('549')) t = '549' + t.slice(2);
  return t;
}

const template = fs.readFileSync(cfg.template, 'utf8').trim();

function buildMessage(row: Row): string {
  const base = row.mensaje ? String(row.mensaje) : template;
  return base.replace(/\{([^}]+)\}/g, (match: string, col: string) => String(row[normCol(col)] ?? match));
}

function readRows(): Row[] {
  // CSVs are read as UTF-8 so accents don't break (XLSX.readFile uses another encoding)
  const wb = /\.csv$/i.test(cfg.contacts)
    ? XLSX.read(fs.readFileSync(cfg.contacts, 'utf8'), { type: 'string' })
    : XLSX.readFile(cfg.contacts);
  const sheetName = cfg.sheet || wb.SheetNames[0];
  const sheet = sheetName ? wb.Sheets[sheetName] : undefined;
  if (!sheet) throw new Error(`No existe la hoja "${sheetName}" en ${cfg.contacts}`);
  return XLSX.utils
    .sheet_to_json<Row>(sheet, { defval: '' })
    .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [normCol(k), v])));
}

// Final status of each phone in the log. Errors are retried; sent numbers and numbers
// without WhatsApp are not, so they aren't checked again on every resume.
function alreadyProcessed(): Map<string, Status> {
  const statuses = new Map<string, Status>();
  if (!fs.existsSync(cfg.log)) return statuses;
  for (const line of fs.readFileSync(cfg.log, 'utf8').split('\n').slice(1)) {
    const [, phone, status] = line.split(',');
    if (phone && status && statuses.get(phone) !== 'enviado') statuses.set(phone, status as Status);
  }
  return statuses;
}

function record(phone: string, status: Status, detail = ''): void {
  if (!fs.existsSync(cfg.log)) fs.writeFileSync(cfg.log, 'fecha,telefono,estado,detalle\n');
  const clean = detail.replace(/[\n,]/g, ' ');
  fs.appendFileSync(cfg.log, `${new Date().toISOString()},${phone},${status},${clean}\n`);
}

async function main(): Promise<void> {
  const rows = readRows();
  const processed = alreadyProcessed();
  const skip = (phone: string): boolean => ['enviado', 'sin_whatsapp'].includes(processed.get(phone) ?? '');
  // If there's no exact column, use the first one that starts the same (e.g. "telefono" → "telefono 1")
  const columns = Object.keys(rows[0] ?? {});
  const wanted = normCol(cfg.phoneColumn);
  const phoneCol = columns.includes(wanted) ? wanted : columns.find((c) => c.startsWith(wanted));
  if (!phoneCol) throw new Error(`No hay columna "${cfg.phoneColumn}" en el Excel. Columnas: ${columns.join(', ')}`);
  // If a number appears several times in the spreadsheet, only the first row gets a message
  const seen = new Set<string>();
  const pending: Pending[] = [];
  for (const row of rows) {
    const phone = normalizePhone(row[phoneCol]);
    if (!phone || skip(phone) || seen.has(phone)) continue;
    seen.add(phone);
    pending.push({ row, phone });
  }

  const howMany = (status: Status): number => [...processed.values()].filter((s) => s === status).length;
  console.log(
    `${rows.length} filas en el Excel: ${howMany('enviado')} ya enviadas, ` +
      `${howMany('sin_whatsapp')} sin WhatsApp (se saltean), ${pending.length} pendientes.`
  );

  if (DRY_RUN) {
    for (const { row, phone } of pending) {
      console.log(`\n→ ${phone}\n${buildMessage(row)}`);
    }
    console.log('\n(modo prueba: no se envió nada)');
    return;
  }
  if (!pending.length) return;

  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(1);
    stopping = true;
    log('\nDeteniendo después del mensaje actual... (Ctrl+C otra vez para forzar)');
  });

  let session = await connect();
  log(`[${clock()}] Conectado a WhatsApp.\n`);

  const total = pending.length;
  let reconnects = 0;
  let sentInBatch = 0; // messages sent since the last break
  for (let i = 0; i < total && !stopping; i++) {
    const { row, phone } = pending[i]!;
    const prefix = `[${clock()}] (${i + 1}/${total}) ${phone}`;
    const result = (status: Status, text: string, detail?: string): void => {
      counts[status]++;
      record(phone, status, detail);
      log(`${prefix}: ${text}`);
    };
    showBar(i, total, `enviando a ${phone}...`);
    try {
      if (session.down || !session.client) throw new Error(`WhatsApp se desconectó (${session.down})`);
      const client = session.client;
      const id = await client.getNumberId(phone);
      if (!id) {
        result('sin_whatsapp', '\x1b[33msin WhatsApp\x1b[0m');
        continue;
      }

      const attachment = cfg.attachmentColumn && row[normCol(cfg.attachmentColumn)];
      if (attachment) {
        const media = MessageMedia.fromFilePath(path.resolve(path.dirname(cfg.contacts), String(attachment)));
        await client.sendMessage(id._serialized, media, { caption: buildMessage(row) });
      } else {
        await client.sendMessage(id._serialized, buildMessage(row));
      }
      result('enviado', '\x1b[32menviado\x1b[0m');
      sentInBatch++;
      reconnects = 0;
    } catch (e) {
      const msg = errorMessage(e);
      if (!(session.down || connectionLost(msg))) {
        result('error', `\x1b[31mERROR\x1b[0m ${msg}`, msg);
      } else if (session.down === 'LOGOUT') {
        log(`${prefix}: \x1b[31mse cerró la sesión de WhatsApp en el teléfono.\x1b[0m Volvé a arrancar y escaneá el QR.`);
        break;
      } else if (++reconnects > MAX_RECONNECTS) {
        log(`${prefix}: \x1b[31mno se pudo reconectar después de ${MAX_RECONNECTS} intentos.\x1b[0m Volvé a arrancar más tarde.`);
        break;
      } else {
        // The WhatsApp Web page reloaded or dropped: open a new session and retry this number
        log(`${prefix}: \x1b[33mse perdió la conexión\x1b[0m (${msg}). Reconectando (intento ${reconnects}/${MAX_RECONNECTS})...`);
        await close(session.client);
        for (let s = 30; s > 0 && !stopping; s--) {
          showBar(i, total, `reconectando en ${s}s`);
          await sleep(1000);
        }
        if (stopping) break;
        try {
          showBar(i, total, 'reconectando...');
          session = await connect(3 * 60 * 1000);
          log(`[${clock()}] \x1b[32mReconectado a WhatsApp.\x1b[0m`);
        } catch (err) {
          log(`[${clock()}] No se pudo reconectar: ${errorMessage(err)}`);
          session = { client: null, down: 'sin conexión' };
        }
        i--;
        continue;
      }
    } finally {
      showBar(i + 1, total);
    }

    if (i < total - 1 && !stopping && cfg.batchSize > 0 && sentInBatch >= cfg.batchSize) {
      // End of the batch: long break instead of the normal delay
      const sec = Math.round((cfg.minBreak + Math.random() * (cfg.maxBreak - cfg.minBreak)) * 60);
      log(`[${clock()}] Tanda de ${sentInBatch} mensajes completa. Descansando ${duration(sec)}...`);
      for (let s = sec; s > 0 && !stopping; s--) {
        showBar(i + 1, total, `descanso, sigue en ${countdown(s)}`);
        await sleep(1000);
      }
      sentInBatch = 0;
    } else if (i < total - 1 && !stopping) {
      const sec = Math.round(cfg.minDelay + Math.random() * (cfg.maxDelay - cfg.minDelay));
      if (!TTY) console.log(`   esperando ${sec}s...`);
      for (let s = sec; s > 0 && !stopping; s--) {
        showBar(i + 1, total, `próximo en ${s}s`);
        await sleep(1000);
      }
    }
  }

  log(`\n[${clock()}] Listo: ${counts.enviado} enviados, ${counts.sin_whatsapp} sin WhatsApp, ${counts.error} errores.`);
  log(`Revisá ${path.relative(process.cwd(), cfg.log)}`);
  await sleep(3000); // let the last send finish before closing
  await close(session.client);
  process.exit(0);
}

// Errors meaning the WhatsApp Web page was lost (not a problem with the number)
function connectionLost(message: string): boolean {
  return /detached Frame|Session closed|Target closed|Protocol error|Execution context was destroyed|WhatsApp se desconectó/i.test(
    message
  );
}

// Opens WhatsApp Web and waits until it's ready. If WhatsApp reports a disconnection,
// it's stored in session.down so the next send reconnects.
// With `timeoutMs` it fails if it doesn't connect in time (for unattended reconnects).
function connect(timeoutMs?: number): Promise<Session> {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(import.meta.dir, '..', '.wwebjs_auth') }),
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

async function close(client: Client | null): Promise<void> {
  try {
    await client?.destroy();
  } catch {
    // If the page was already broken, destroy can fail too: doesn't matter
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
