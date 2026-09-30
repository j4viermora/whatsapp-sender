export type Config = {
  contacts: string;
  sheet: string | null;
  phoneColumn: string;
  attachmentColumn: string | null;
  countryCode: string;
  template: string;
  minDelay: number;
  maxDelay: number;
  batchSize: number;
  minBreak: number;
  maxBreak: number;
  log: string;
}

export type Pending = {
  row: Row;
  phone: string;
}


/** A spreadsheet row, keyed by normalized column name */
export type Row = Record<string, unknown>;

/** Status written to the log. The values stay in Spanish so existing logs keep working. */
export type Status = 'enviado' | 'sin_whatsapp' | 'error';