const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const cfg = require('./config');

// Las rutas de config.js son relativas a esta carpeta, no a desde dónde se ejecuta
for (const k of ['excel', 'plantilla', 'log']) cfg[k] = path.resolve(__dirname, cfg[k]);

const DRY_RUN = process.argv.includes('--prueba');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hora = () => new Date().toLocaleTimeString('es-AR');
// Nombres de columna sin mayúsculas ni acentos: "Teléfono" y "telefono" son la misma columna
const normCol = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// Barra de progreso en la última línea de la terminal (solo si es una terminal interactiva)
const TTY = process.stdout.isTTY;
const conteo = { enviado: 0, sin_whatsapp: 0, error: 0 };

function duracion(seg) {
  const m = Math.round(seg / 60);
  if (m < 1) return `${Math.round(seg)}s`;
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}min`;
}

const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

function mostrarBarra(hechos, total, extra = '') {
  if (!TTY) return;
  const pct = Math.round((hechos / total) * 100);
  const restante = (total - hechos) * ((cfg.esperaMin + cfg.esperaMax) / 2 + 3);
  const partes = {
    cuenta: `${hechos}/${total} (${pct}%)`,
    stats: `\x1b[32m✓ ${conteo.enviado}\x1b[0m  \x1b[33m⊘ ${conteo.sin_whatsapp}\x1b[0m  \x1b[31m✗ ${conteo.error}\x1b[0m`,
    eta: hechos < total ? `~${duracion(restante)} restantes` : '',
    extra,
  };
  // La línea nunca puede superar el ancho de la terminal: si se parte en dos, cada
  // actualización deja un renglón nuevo. Si no entra, se sacan datos en este orden.
  const cols = (process.stdout.columns || 80) - 1;
  const texto = () => Object.values(partes).filter(Boolean).join('  ');
  for (const k of ['eta', 'stats', 'extra']) {
    if (visible(texto()) + 6 <= cols) break;
    partes[k] = '';
  }
  const ancho = Math.max(0, Math.min(25, cols - visible(texto()) - 1));
  const lleno = Math.round((hechos / total) * ancho);
  const barra = ancho ? '\x1b[32m' + '█'.repeat(lleno) + '\x1b[90m' + '░'.repeat(ancho - lleno) + '\x1b[0m ' : '';
  process.stdout.write(`\r\x1b[K${barra}${texto()}`);
}

// Imprime una línea normal sin pisar la barra
function log(msg) {
  if (TTY) process.stdout.write('\r\x1b[K');
  console.log(msg);
}

function normalizarTelefono(valor) {
  let t = String(valor ?? '').replace(/\D/g, '');
  if (!t) return null;
  if (t.startsWith('00')) t = t.slice(2);
  if (t.startsWith('0')) t = t.slice(1);
  if (!t.startsWith(cfg.codigoPais)) t = cfg.codigoPais + t;
  // Argentina: los celulares en WhatsApp llevan un 9 después del 54
  if (cfg.codigoPais === '54' && !t.startsWith('549')) t = '549' + t.slice(2);
  return t;
}

const plantilla = fs.readFileSync(cfg.plantilla, 'utf8').trim();

function armarMensaje(fila) {
  const base = fila.mensaje ? String(fila.mensaje) : plantilla;
  return base.replace(/\{([^}]+)\}/g, (m, col) => (fila[normCol(col)] ?? m).toString());
}

function leerFilas() {
  // Los CSV se leen como UTF-8 para no romper acentos (XLSX.readFile usa otra codificación)
  const wb = /\.csv$/i.test(cfg.excel)
    ? XLSX.read(fs.readFileSync(cfg.excel, 'utf8'), { type: 'string' })
    : XLSX.readFile(cfg.excel);
  const hoja = cfg.hoja || wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[hoja], { defval: '' }).map((f) =>
    Object.fromEntries(Object.entries(f).map(([k, v]) => [normCol(k), v]))
  );
}

// Estado final de cada teléfono en el log. Los que dieron error se reintentan; los enviados
// y los sin WhatsApp no, para no revisarlos de nuevo cada vez que se reanuda.
function yaProcesados() {
  const estados = new Map();
  if (!fs.existsSync(cfg.log)) return estados;
  for (const l of fs.readFileSync(cfg.log, 'utf8').split('\n').slice(1)) {
    const [, tel, estado] = l.split(',');
    if (tel && estados.get(tel) !== 'enviado') estados.set(tel, estado);
  }
  return estados;
}

function registrar(telefono, estado, detalle = '') {
  if (!fs.existsSync(cfg.log)) fs.writeFileSync(cfg.log, 'fecha,telefono,estado,detalle\n');
  const limpio = String(detalle).replace(/[\n,]/g, ' ');
  fs.appendFileSync(cfg.log, `${new Date().toISOString()},${telefono},${estado},${limpio}\n`);
}

async function main() {
  const filas = leerFilas();
  const procesados = yaProcesados();
  const saltear = (tel) => ['enviado', 'sin_whatsapp'].includes(procesados.get(tel));
  // Si no hay columna exacta, usa la primera que empiece igual (ej. "telefono" → "telefono 1")
  const columnas = Object.keys(filas[0] || {});
  const buscada = normCol(cfg.columnaTelefono);
  const colTel = columnas.includes(buscada) ? buscada : columnas.find((c) => c.startsWith(buscada));
  if (!colTel) throw new Error(`No hay columna "${cfg.columnaTelefono}" en el Excel. Columnas: ${columnas.join(', ')}`);
  // Si un número aparece varias veces en el Excel, se le envía solo a la primera fila
  const vistos = new Set();
  const pendientes = filas
    .map((f) => ({ fila: f, tel: normalizarTelefono(f[colTel]) }))
    .filter(({ tel }) => tel && !saltear(tel) && !vistos.has(tel) && vistos.add(tel));

  const cuantos = (estado) => [...procesados.values()].filter((e) => e === estado).length;
  console.log(
    `${filas.length} filas en el Excel: ${cuantos('enviado')} ya enviadas, ` +
      `${cuantos('sin_whatsapp')} sin WhatsApp (se saltean), ${pendientes.length} pendientes.`
  );

  if (DRY_RUN) {
    for (const { fila, tel } of pendientes) {
      console.log(`\n→ ${tel}\n${armarMensaje(fila)}`);
    }
    console.log('\n(modo prueba: no se envió nada)');
    return;
  }
  if (!pendientes.length) return;

  let detener = false;
  process.on('SIGINT', async () => {
    if (detener) process.exit(1);
    detener = true;
    log('\nDeteniendo después del mensaje actual... (Ctrl+C otra vez para forzar)');
  });

  let client = await conectar();
  log(`[${hora()}] Conectado a WhatsApp.\n`);

  const total = pendientes.length;
  let reconexiones = 0;
  for (let i = 0; i < total && !detener; i++) {
    const { fila, tel } = pendientes[i];
    const prefijo = `[${hora()}] (${i + 1}/${total}) ${tel}`;
    const resultado = (estado, texto, detalle) => {
      conteo[estado]++;
      registrar(tel, estado, detalle);
      log(`${prefijo}: ${texto}`);
    };
    mostrarBarra(i, total, `enviando a ${tel}...`);
    try {
      if (client.caido) throw new Error(`WhatsApp se desconectó (${client.caido})`);
      const id = await client.getNumberId(tel);
      if (!id) {
        resultado('sin_whatsapp', '\x1b[33msin WhatsApp\x1b[0m');
        continue;
      }

      const adjunto = cfg.columnaAdjunto && fila[normCol(cfg.columnaAdjunto)];
      if (adjunto) {
        const media = MessageMedia.fromFilePath(path.resolve(path.dirname(cfg.excel), String(adjunto)));
        await client.sendMessage(id._serialized, media, { caption: armarMensaje(fila) });
      } else {
        await client.sendMessage(id._serialized, armarMensaje(fila));
      }
      resultado('enviado', '\x1b[32menviado\x1b[0m');
      reconexiones = 0;
    } catch (e) {
      if (!(client.caido || conexionPerdida(e))) {
        resultado('error', `\x1b[31mERROR\x1b[0m ${e.message}`, e.message);
      } else if (client.caido === 'LOGOUT') {
        log(`${prefijo}: \x1b[31mse cerró la sesión de WhatsApp en el teléfono.\x1b[0m Volvé a arrancar y escaneá el QR.`);
        break;
      } else if (++reconexiones > MAX_RECONEXIONES) {
        log(`${prefijo}: \x1b[31mno se pudo reconectar después de ${MAX_RECONEXIONES} intentos.\x1b[0m Volvé a arrancar más tarde.`);
        break;
      } else {
        // La página de WhatsApp Web se recargó o se cortó: abrir una sesión nueva y repetir este número
        log(`${prefijo}: \x1b[33mse perdió la conexión\x1b[0m (${e.message}). Reconectando (intento ${reconexiones}/${MAX_RECONEXIONES})...`);
        await cerrar(client);
        for (let s = 30; s > 0 && !detener; s--) {
          mostrarBarra(i, total, `reconectando en ${s}s`);
          await sleep(1000);
        }
        if (detener) break;
        try {
          mostrarBarra(i, total, 'reconectando...');
          client = await conectar(3 * 60 * 1000);
          log(`[${hora()}] \x1b[32mReconectado a WhatsApp.\x1b[0m`);
        } catch (err) {
          log(`[${hora()}] No se pudo reconectar: ${err.message}`);
          client = { caido: 'sin conexión' };
        }
        i--;
        continue;
      }
    } finally {
      mostrarBarra(i + 1, total);
    }

    if (i < total - 1 && !detener) {
      const seg = Math.round(cfg.esperaMin + Math.random() * (cfg.esperaMax - cfg.esperaMin));
      if (!TTY) console.log(`   esperando ${seg}s...`);
      for (let s = seg; s > 0 && !detener; s--) {
        mostrarBarra(i + 1, total, `próximo en ${s}s`);
        await sleep(1000);
      }
    }
  }

  log(`\n[${hora()}] Listo: ${conteo.enviado} enviados, ${conteo.sin_whatsapp} sin WhatsApp, ${conteo.error} errores.`);
  log(`Revisá ${path.relative(process.cwd(), cfg.log)}`);
  await sleep(3000); // deja terminar el último envío antes de cerrar
  await cerrar(client);
  process.exit(0);
}

const MAX_RECONEXIONES = 5;

// Errores que indican que se perdió la página de WhatsApp Web (no un problema del número)
function conexionPerdida(e) {
  return /detached Frame|Session closed|Target closed|Protocol error|Execution context was destroyed|WhatsApp se desconectó/i.test(
    String(e && e.message)
  );
}

// Abre WhatsApp Web y espera a que esté listo. Si WhatsApp avisa que se desconectó,
// se marca en client.caido para que el próximo envío reconecte.
// Con `limiteMs` falla si no conecta a tiempo (para reconexiones sin nadie mirando).
function conectar(limiteMs) {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '..', '.wwebjs_auth') }),
    puppeteer: { headless: true },
  });
  client.on('qr', (qr) => {
    log('Escaneá este QR desde WhatsApp > Dispositivos vinculados:');
    qrcode.generate(qr, { small: true });
  });
  client.on('disconnected', (motivo) => {
    client.caido = String(motivo || 'desconectado');
  });

  return new Promise((resolve, reject) => {
    const limite = limiteMs && setTimeout(() => {
      cerrar(client);
      reject(new Error(`WhatsApp no respondió en ${limiteMs / 60000} minutos`));
    }, limiteMs);
    client.once('ready', () => {
      clearTimeout(limite);
      resolve(client);
    });
    client.once('auth_failure', (m) => {
      clearTimeout(limite);
      cerrar(client);
      reject(new Error(`Error de autenticación: ${m}`));
    });
    client.initialize().catch((e) => {
      clearTimeout(limite);
      cerrar(client);
      reject(e);
    });
  });
}

async function cerrar(client) {
  try {
    if (client.destroy) await client.destroy();
  } catch {
    // Si la página ya estaba rota, destroy también puede fallar: no importa
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
