import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import type { Row } from '../types';

// Column names without case or accents: "Teléfono" and "telefono" are the same column
export const normCol = (s: unknown): string =>
  String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function readRows(file: string, sheetName: string | null): Row[] {
  // CSVs are read as UTF-8 so accents don't break (XLSX.readFile uses another encoding)
  const wb = /\.csv$/i.test(file)
    ? XLSX.read(fs.readFileSync(file, 'utf8'), { type: 'string' })
    : XLSX.readFile(file);
  const name = sheetName || wb.SheetNames[0];
  const sheet = name ? wb.Sheets[name] : undefined;
  if (!sheet) throw new Error(`No existe la hoja "${name}" en ${file}`);
  return XLSX.utils
    .sheet_to_json<Row>(sheet, { defval: '' })
    .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [normCol(k), v])));
}

// If there's no exact column, use the first one that starts the same (e.g. "telefono" → "telefono 1")
export function findPhoneColumn(rows: Row[], name: string): string {
  const columns = Object.keys(rows[0] ?? {});
  const wanted = normCol(name);
  const col = columns.includes(wanted) ? wanted : columns.find((c) => c.startsWith(wanted));
  if (!col) throw new Error(`No hay columna "${name}" en el Excel. Columnas: ${columns.join(', ')}`);
  return col;
}

export function normalizePhone(value: unknown, countryCode: string): string | null {
  let t = String(value ?? '').replace(/\D/g, '');
  if (!t) return null;
  if (t.startsWith('00')) t = t.slice(2);
  if (t.startsWith('0')) t = t.slice(1);
  if (!t.startsWith(countryCode)) t = countryCode + t;
  // Argentina: mobile numbers on WhatsApp have a 9 after the 54
  if (countryCode === '54' && !t.startsWith('549')) t = '549' + t.slice(2);
  return t;
}

export const readTemplate = (file: string): string => fs.readFileSync(file, 'utf8').trim();

export function buildMessage(row: Row, template: string): string {
  const base = row.mensaje ? String(row.mensaje) : template;
  return base.replace(/\{([^}]+)\}/g, (match: string, col: string) => String(row[normCol(col)] ?? match));
}

// Attachment paths in the spreadsheet are relative to the contacts file's folder
export function attachmentPath(row: Row, column: string | null, contactsFile: string): string | null {
  const value = column && row[normCol(column)];
  return value ? path.resolve(path.dirname(contactsFile), String(value)) : null;
}
