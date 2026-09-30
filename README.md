# whatsapp-sender

Envía mensajes de WhatsApp personalizados a una lista de contactos leída desde un Excel, usando [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) (tu propia cuenta, vinculada como dispositivo).

## Características

- Lee contactos desde un `.xlsx` y arma cada mensaje con una plantilla (`{columna}` se reemplaza por el valor de esa fila).
- Permite un mensaje propio por fila (columna `mensaje`) y un adjunto opcional (PDF, imagen, etc.).
- Normaliza teléfonos y agrega el código de país (por defecto Venezuela, `58`).
- Verifica que cada número tenga WhatsApp antes de enviar; si no tiene, lo registra como `sin_whatsapp` y sigue con el próximo.
- Los nombres de columna no distinguen mayúsculas ni acentos (`Teléfono`, `TELEFONO` y `telefono` son lo mismo).
- Espera un tiempo aleatorio entre mensajes y, cada 30 mensajes enviados, descansa entre 10 y 15 minutos para reducir el riesgo de bloqueo.
- Registra cada envío en `src/enviados.csv` y **reanuda** automáticamente: no reenvía a quien ya figura como `enviado`.
- Modo prueba para ver los mensajes sin enviar nada.

## Requisitos

- [Bun](https://bun.sh) 1.1 o superior (`curl -fsSL https://bun.sh/install | bash`, o `mise use -g bun`)
- Una cuenta de WhatsApp en el teléfono para escanear el QR

## Instalación

```bash
bun install
```

El código está en TypeScript (`src/send.ts` y `src/config.ts`) y Bun lo ejecuta directamente, sin compilar. Para revisar los tipos: `bun run typecheck`.

## Primer uso: crear los archivos de contactos y de mensaje

El repositorio **no incluye ningún archivo `.xlsx` ni `.csv`, ni el archivo `src/mensaje.txt`** (están en `.gitignore` porque contienen datos personales o tu propio texto). La primera vez tenés que crearlos vos.

### Contactos

1. Guardá tu archivo de contactos en la carpeta `src/db/` (ya viene creada, vacía), por ejemplo `src/db/contactos.xlsx` (o `.csv`), con el formato que se describe abajo.
2. Apuntá `contacts` en `src/config.ts` a ese archivo (`contacts: './db/contactos.xlsx'`).

Ejemplo mínimo de `src/db/contactos.csv`:

```csv
telefono,nombre
04122464031,Ana
0414-555-1234,Juan
```

### Mensaje

Copiá el ejemplo y editalo con tu texto:

```bash
cp src/mensaje.ejemplo.txt src/mensaje.txt
```

Ver la sección [Mensaje](#mensaje) para el formato.

El registro `src/enviados.csv` no hace falta crearlo: se genera solo en el primer envío.

## Formato de los contactos

Puede ser un Excel (`.xlsx`) o un `.csv` (separado por `,` o `;`, en UTF-8). Los archivos van en `src/db/`; para elegir cuál usar, cambiá `contacts` en `src/config.ts`, por ejemplo `contacts: './db/caracas.xlsx'`.

La primera fila debe tener los nombres de las columnas. Ejemplo:

| Teléfono        | Nombre | mensaje (opcional)          | adjunto (opcional)   |
|-----------------|--------|-----------------------------|----------------------|
| (0412)246.4031  | Ana    |                             | ./archivos/promo.pdf |
| 0414-555-1234   | Juan   | Hola Juan, mensaje especial |                      |

- Los nombres de columna no distinguen mayúsculas ni acentos: `Nombre`, `nombre` y `NOMBRE` son la misma columna.
- `telefono`: se aceptan paréntesis, puntos, espacios, guiones, `+` y `0` o `00` iniciales; se limpian solos. Si falta el código de país, se agrega el de `countryCode` (`(0412)246.4031` → `584122464031`). Si no hay una columna llamada exactamente `telefono`, se usa la primera que empiece así (por ejemplo `Teléfono 1`).
- `mensaje`: si tiene valor, reemplaza a la plantilla para esa fila.
- `adjunto`: ruta a un archivo; el mensaje se envía como epígrafe.
- Cualquier otra columna puede usarse en la plantilla como `{columna}`.

## Configuración

Editá `src/config.ts`. Las rutas son relativas a la carpeta `src/`, y las de los adjuntos, relativas a la carpeta del archivo de contactos.

| Opción            | Descripción                                                   | Valor por defecto        |
|-------------------|---------------------------------------------------------------|--------------------------|
| `contacts`        | Ruta al archivo de contactos (`.xlsx` o `.csv`)               | `./db/contactos.xlsx`    |
| `sheet`           | Nombre de la hoja (`null` = primera)                          | `null`                   |
| `phoneColumn`     | Columna con el teléfono (o prefijo, ej. `Teléfono 1`)         | `telefono`               |
| `attachmentColumn` | Columna con la ruta del adjunto                               | `adjunto`                |
| `countryCode`     | Código de país a agregar si falta                             | `58` (Venezuela)         |
| `template`        | Archivo de texto con el mensaje (ver abajo)                   | `./mensaje.txt`          |
| `minDelay` / `maxDelay` | Rango de espera aleatoria entre mensajes (segundos)   | `60` / `180`             |
| `batchSize`      | Mensajes enviados por tanda antes de un descanso (`0` = sin tandas) | `30`             |
| `minBreak` / `maxBreak` | Rango del descanso aleatorio entre tandas (minutos) | `10` / `15`              |
| `log`             | Archivo CSV de registro                                       | `./enviados.csv`         |

## Mensaje

El texto del mensaje está en `src/mensaje.txt` (crealo la primera vez copiando `src/mensaje.ejemplo.txt`): editalo con cualquier editor. Puede tener varias líneas y usar `{columna}` para insertar datos de cada contacto, por ejemplo:

```
Hola, {nombre} 👋

Soy Ana, de Ferretería El Tornillo. Esta semana tenemos...
```

Las variables tampoco distinguen mayúsculas ni acentos: `{nombre}` toma la columna `Nombre`. Si una variable no existe como columna, queda escrita tal cual (`{columna}`), así que revisá con `bun run dry-run` antes de enviar.

## Uso

1. **Probar** (muestra cada número y mensaje, no envía nada):

   ```bash
   bun run dry-run
   ```

2. **Enviar**:

   ```bash
   bun run send
   ```

   La primera vez se muestra un QR en la terminal: escanealo desde WhatsApp → *Dispositivos vinculados*. La sesión queda guardada en `.wwebjs_auth/`, así que las siguientes veces no hace falta.

3. **Detener**: `Ctrl+C` termina después del mensaje en curso; `Ctrl+C` de nuevo fuerza la salida. Al volver a ejecutar, continúa con los pendientes.

## Registro (`src/enviados.csv`)

Columnas: `fecha,telefono,estado,detalle`. Estados posibles:

- `enviado` — el mensaje se envió.
- `sin_whatsapp` — el número no tiene WhatsApp.
- `error` — falló el envío (el detalle trae el motivo).

Solo los `enviado` se saltean al reanudar; los `sin_whatsapp` y `error` se reintentan. Para empezar de cero, borrá `src/enviados.csv`.

## Advertencias

- WhatsApp no permite oficialmente la automatización de cuentas personales. Usalo con contactos que esperan tu mensaje, con volúmenes moderados y esperas razonables: el envío masivo puede provocar el bloqueo del número.
- `src/db/`, `src/enviados.csv`, `src/mensaje.txt` y cualquier archivo `.xlsx`, `.xls` o `.csv` están en `.gitignore` para no subir datos personales ni tu mensaje al repositorio.
