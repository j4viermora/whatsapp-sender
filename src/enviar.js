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

function mostrarBarra(hechos, total, extra = '') {
  if (!TTY) return;
  const ancho = 25;
  const lleno = Math.round((hechos / total) * ancho);
  const pct = Math.round((hechos / total) * 100);
  const restante = (total - hechos) * ((cfg.esperaMin + cfg.esperaMax) / 2 + 3);
  const barra = '\x1b[32m' + '█'.repeat(lleno) + '\x1b[90m' + '░'.repeat(ancho - lleno) + '\x1b[0m';
  const stats = `\x1b[32m✓ ${conteo.enviado}\x1b[0m  \x1b[33m⊘ ${conteo.sin_whatsapp}\x1b[0m  \x1b[31m✗ ${conteo.error}\x1b[0m`;
  const eta = hechos < total ? `  ~${duracion(restante)} restantes` : '';
  process.stdout.write(`\r\x1b[K${barra} ${hechos}/${total} (${pct}%)  ${stats}${eta}${extra ? '  · ' + extra : ''}`);
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

function yaEnviados() {
  if (!fs.existsSync(cfg.log)) return new Set();
  return new Set(
    fs.readFileSync(cfg.log, 'utf8').split('\n').slice(1)
      .map((l) => l.split(','))
      .filter((c) => c[2] === 'enviado')
      .map((c) => c[1])
  );
}

function registrar(telefono, estado, detalle = '') {
  if (!fs.existsSync(cfg.log)) fs.writeFileSync(cfg.log, 'fecha,telefono,estado,detalle\n');
  const limpio = String(detalle).replace(/[\n,]/g, ' ');
  fs.appendFileSync(cfg.log, `${new Date().toISOString()},${telefono},${estado},${limpio}\n`);
}

async function main() {
  const filas = leerFilas();
  const enviados = yaEnviados();
  // Si no hay columna exacta, usa la primera que empiece igual (ej. "telefono" → "telefono 1")
  const columnas = Object.keys(filas[0] || {});
  const buscada = normCol(cfg.columnaTelefono);
  const colTel = columnas.includes(buscada) ? buscada : columnas.find((c) => c.startsWith(buscada));
  if (!colTel) throw new Error(`No hay columna "${cfg.columnaTelefono}" en el Excel. Columnas: ${columnas.join(', ')}`);
  const pendientes = filas
    .map((f) => ({ fila: f, tel: normalizarTelefono(f[colTel]) }))
    .filter(({ tel }) => tel && !enviados.has(tel));

  console.log(`${filas.length} filas en el Excel, ${enviados.size} ya enviadas, ${pendientes.length} pendientes.`);

  if (DRY_RUN) {
    for (const { fila, tel } of pendientes) {
      console.log(`\n→ ${tel}\n${armarMensaje(fila)}`);
    }
    console.log('\n(modo prueba: no se envió nada)');
    return;
  }
  if (!pendientes.length) return;

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '..', '.wwebjs_auth') }),
    puppeteer: { headless: true },
  });

  client.on('qr', (qr) => {
    console.log('Escaneá este QR desde WhatsApp > Dispositivos vinculados:');
    qrcode.generate(qr, { small: true });
  });
  client.on('auth_failure', (m) => console.error('Error de autenticación:', m));

  let detener = false;
  process.on('SIGINT', async () => {
    if (detener) process.exit(1);
    detener = true;
    log('\nDeteniendo después del mensaje actual... (Ctrl+C otra vez para forzar)');
  });

  client.on('ready', async () => {
    console.log(`[${hora()}] Conectado a WhatsApp.\n`);

    const total = pendientes.length;
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
      } catch (e) {
        resultado('error', `\x1b[31mERROR\x1b[0m ${e.message}`, e.message);
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
    await client.destroy();
    process.exit(0);
  });

  client.initialize();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
