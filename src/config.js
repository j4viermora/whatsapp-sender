module.exports = {
  // Ruta al archivo de contactos (.xlsx o .csv) y hoja (null = primera hoja; se ignora en CSV)
  excel: './db/caracas.xlsx',
  hoja: null,

  // Nombres de columnas en el Excel
  columnaTelefono: 'telefono',
  columnaAdjunto: 'adjunto', // opcional: ruta a un PDF/imagen por fila

  // Código de país que se agrega si el número no lo trae (58 = Venezuela)
  codigoPais: '58',

  // Archivo de texto con la plantilla del mensaje. {columna} se reemplaza por el valor de esa columna.
  // Si el Excel tiene una columna "mensaje", se usa esa en lugar de la plantilla.
  plantilla: './mensaje.txt',

  // Espera aleatoria entre mensajes (segundos)
  esperaMin: 30,
  esperaMax: 120,

  // Archivo donde se registra cada envío (también sirve para reanudar)
  log: './enviados.csv',
};
