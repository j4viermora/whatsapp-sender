import path from 'node:path';
import { type Config, type Pending, type Status } from './types';
import baseConfig from './config';
import {
  attachmentPath,
  buildMessage,
  findPhoneColumn,
  normalizePhone,
  readRows,
  readTemplate,
} from './services/contacts';
import { alreadyProcessed, record } from './services/sent-log';
import { close, connect, connectionLost, sendMessage } from './services/whatsapp';

// Paths in config.ts are relative to this folder, not to where the script is run from
const cfg: Config = {
  ...baseConfig,
  contacts: path.resolve(import.meta.dir, baseConfig.contacts),
  template: path.resolve(import.meta.dir, baseConfig.template),
  log: path.resolve(import.meta.dir, baseConfig.log),
};

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_RECONNECTS = 5;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const clock = (): string => new Date().toLocaleTimeString('es-AR');

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

async function main(): Promise<void> {
  const rows = readRows(cfg.contacts, cfg.sheet);
  const template = readTemplate(cfg.template);
  const processed = alreadyProcessed(cfg.log);
  const skip = (phone: string): boolean => ['enviado', 'sin_whatsapp'].includes(processed.get(phone) ?? '');
  const phoneCol = findPhoneColumn(rows, cfg.phoneColumn);
  // If a number appears several times in the spreadsheet, only the first row gets a message
  const seen = new Set<string>();
  const pending: Pending[] = [];
  for (const row of rows) {
    const phone = normalizePhone(row[phoneCol], cfg.countryCode);
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
      console.log(`\n→ ${phone}\n${buildMessage(row, template)}`);
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

  let session = await connect(log);
  log(`[${clock()}] Conectado a WhatsApp.\n`);

  const total = pending.length;
  let reconnects = 0;
  let sentInBatch = 0; // messages sent since the last break
  for (let i = 0; i < total && !stopping; i++) {
    const { row, phone } = pending[i]!;
    const prefix = `[${clock()}] (${i + 1}/${total}) ${phone}`;
    const result = (status: Status, text: string, detail?: string): void => {
      counts[status]++;
      record(cfg.log, phone, status, detail);
      log(`${prefix}: ${text}`);
    };
    showBar(i, total, `enviando a ${phone}...`);
    try {
      const attachment = attachmentPath(row, cfg.attachmentColumn, cfg.contacts);
      const status = await sendMessage(session, phone, buildMessage(row, template), attachment);
      if (status === 'sin_whatsapp') {
        result('sin_whatsapp', '\x1b[33msin WhatsApp\x1b[0m');
        continue;
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
          session = await connect(log, 3 * 60 * 1000);
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

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
