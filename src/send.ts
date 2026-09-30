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
import { close, connect, connectionLost, sendMessage, type Session } from './services/whatsapp';
import { TTY, clock, createProgress, duration, log, mmss } from './services/progress';

// Paths in config.ts are relative to this folder, not to where the script is run from
const cfg: Config = {
  ...baseConfig,
  contacts: path.resolve(import.meta.dir, baseConfig.contacts),
  template: path.resolve(import.meta.dir, baseConfig.template),
  log: path.resolve(import.meta.dir, baseConfig.log),
};

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_RECONNECTS = 5;
const RECONNECT_WAIT = 30; // seconds
const RECONNECT_TIMEOUT = 3 * 60 * 1000;

let stopping = false; // set by Ctrl+C: finish the current message and stop

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const randomBetween = (min: number, max: number): number => Math.round(min + Math.random() * (max - min));
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Waits `sec` seconds calling `tick` every second, or less if Ctrl+C is pressed
async function countdown(sec: number, tick: (left: number) => void): Promise<void> {
  for (let s = sec; s > 0 && !stopping; s--) {
    tick(s);
    await sleep(1000);
  }
}

// Seconds that `left` messages will take, counting delays and batch breaks
function estimate(left: number): number {
  let sec = left * ((cfg.minDelay + cfg.maxDelay) / 2 + 3);
  if (cfg.batchSize > 0) sec += Math.floor(left / cfg.batchSize) * ((cfg.minBreak + cfg.maxBreak) / 2) * 60;
  return sec;
}

// Contacts still to message. Numbers already sent or without WhatsApp are skipped, and if
// a number appears several times in the spreadsheet, only the first row gets a message.
function loadPending(): Pending[] {
  const rows = readRows(cfg.contacts, cfg.sheet);
  const processed = alreadyProcessed(cfg.log);
  const phoneCol = findPhoneColumn(rows, cfg.phoneColumn);
  const seen = new Set<string>();
  const pending: Pending[] = [];
  for (const row of rows) {
    const phone = normalizePhone(row[phoneCol], cfg.countryCode);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    const status = processed.get(phone);
    if (status !== 'enviado' && status !== 'sin_whatsapp') pending.push({ row, phone });
  }

  const howMany = (status: Status): number => [...processed.values()].filter((s) => s === status).length;
  console.log(
    `${rows.length} filas en el Excel: ${howMany('enviado')} ya enviadas, ` +
      `${howMany('sin_whatsapp')} sin WhatsApp (se saltean), ${pending.length} pendientes.`
  );
  return pending;
}

// Opens a new session after the connection was lost. Returns null if sending has to stop.
async function reconnect(
  session: Session,
  reason: string,
  attempt: number,
  prefix: string,
  tick: (extra: string) => void
): Promise<Session | null> {
  if (session.down === 'LOGOUT') {
    log(`${prefix}: \x1b[31mse cerró la sesión de WhatsApp en el teléfono.\x1b[0m Volvé a arrancar y escaneá el QR.`);
    return null;
  }
  if (attempt > MAX_RECONNECTS) {
    log(`${prefix}: \x1b[31mno se pudo reconectar después de ${MAX_RECONNECTS} intentos.\x1b[0m Volvé a arrancar más tarde.`);
    return null;
  }
  log(`${prefix}: \x1b[33mse perdió la conexión\x1b[0m (${reason}). Reconectando (intento ${attempt}/${MAX_RECONNECTS})...`);
  await close(session.client);
  await countdown(RECONNECT_WAIT, (s) => tick(`reconectando en ${s}s`));
  if (stopping) return null;
  try {
    tick('reconectando...');
    const next = await connect(log, RECONNECT_TIMEOUT);
    log(`[${clock()}] \x1b[32mReconectado a WhatsApp.\x1b[0m`);
    return next;
  } catch (err) {
    // The next send fails right away and triggers another attempt
    log(`[${clock()}] No se pudo reconectar: ${errorMessage(err)}`);
    return { client: null, down: 'sin conexión' };
  }
}

async function main(): Promise<void> {
  const pending = loadPending();
  const template = readTemplate(cfg.template);

  if (DRY_RUN) {
    for (const { row, phone } of pending) {
      console.log(`\n→ ${phone}\n${buildMessage(row, template)}`);
    }
    console.log('\n(modo prueba: no se envió nada)');
    return;
  }
  if (!pending.length) return;

  process.on('SIGINT', () => {
    if (stopping) process.exit(1);
    stopping = true;
    log('\nDeteniendo después del mensaje actual... (Ctrl+C otra vez para forzar)');
  });

  let session = await connect(log);
  log(`[${clock()}] Conectado a WhatsApp.\n`);

  const total = pending.length;
  const progress = createProgress(total, estimate);
  let reconnects = 0;
  let sentInBatch = 0; // messages sent since the last break
  let i = 0;
  while (i < total && !stopping) {
    const { row, phone } = pending[i]!;
    const prefix = `[${clock()}] (${i + 1}/${total}) ${phone}`;
    progress.show(i, `enviando a ${phone}...`);

    let status: Status;
    let detail = '';
    try {
      status = await sendMessage(
        session,
        phone,
        buildMessage(row, template),
        attachmentPath(row, cfg.attachmentColumn, cfg.contacts)
      );
      reconnects = 0;
    } catch (e) {
      detail = errorMessage(e);
      if (session.down || connectionLost(detail)) {
        // The WhatsApp Web page reloaded or dropped: open a new session and retry this number
        const next = await reconnect(session, detail, ++reconnects, prefix, (extra) => progress.show(i, extra));
        if (!next) break;
        session = next;
        continue;
      }
      status = 'error';
    }

    progress.counts[status]++;
    record(cfg.log, phone, status, detail);
    const text = {
      enviado: '\x1b[32menviado\x1b[0m',
      sin_whatsapp: '\x1b[33msin WhatsApp\x1b[0m',
      error: `\x1b[31mERROR\x1b[0m ${detail}`,
    };
    log(`${prefix}: ${text[status]}`);
    if (status === 'enviado') sentInBatch++;
    progress.show(++i);

    // Nothing was sent to numbers without WhatsApp, so there's no need to wait
    if (i === total || stopping || status === 'sin_whatsapp') continue;
    if (cfg.batchSize > 0 && sentInBatch >= cfg.batchSize) {
      // End of the batch: long break instead of the normal delay
      const sec = randomBetween(cfg.minBreak * 60, cfg.maxBreak * 60);
      log(`[${clock()}] Tanda de ${sentInBatch} mensajes completa. Descansando ${duration(sec)}...`);
      await countdown(sec, (s) => progress.show(i, `descanso, sigue en ${mmss(s)}`));
      sentInBatch = 0;
    } else {
      const sec = randomBetween(cfg.minDelay, cfg.maxDelay);
      if (!TTY) console.log(`   esperando ${sec}s...`);
      await countdown(sec, (s) => progress.show(i, `próximo en ${s}s`));
    }
  }

  const { counts } = progress;
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
