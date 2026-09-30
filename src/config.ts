import type { Config } from "./types";

const config: Config = {
  // Path to the contacts file (.xlsx or .csv) and sheet (null = first sheet; ignored for CSV)
  contacts: './db/caracas.xlsx',
  sheet: null,

  // Column names in the spreadsheet
  phoneColumn: 'telefono',
  attachmentColumn: 'adjunto', // optional: path to a PDF/image per row

  // Country code added when the number doesn't have one (58 = Venezuela)
  countryCode: '58',

  // Text file with the message template. {column} is replaced by that column's value.
  // If the spreadsheet has a "mensaje" column, that one is used instead of the template.
  template: './mensaje.txt',

  // Random delay between messages (seconds)
  minDelay: 30,
  maxDelay: 60,

  // Batches: after sending `batchSize` messages, take a break of `minBreak` to `maxBreak`
  // minutes before continuing. Set batchSize to 0 to disable batches.
  batchSize: 30,
  minBreak: 10,
  maxBreak: 15,

  // File where every send is recorded (also used to resume)
  log: './enviados.csv',
};

export default config;
