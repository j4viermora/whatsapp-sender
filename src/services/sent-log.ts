import fs from 'node:fs';
import type { Status } from '../types';

// Final status of each phone in the log. Errors are retried; sent numbers and numbers
// without WhatsApp are not, so they aren't checked again on every resume.
export function alreadyProcessed(file: string): Map<string, Status> {
  const statuses = new Map<string, Status>();
  if (!fs.existsSync(file)) return statuses;
  for (const line of fs.readFileSync(file, 'utf8').split('\n').slice(1)) {
    const [, phone, status] = line.split(',');
    if (phone && status && statuses.get(phone) !== 'enviado') statuses.set(phone, status as Status);
  }
  return statuses;
}

export function record(file: string, phone: string, status: Status, detail = ''): void {
  if (!fs.existsSync(file)) fs.writeFileSync(file, 'fecha,telefono,estado,detalle\n');
  const clean = detail.replace(/[\n,]/g, ' ');
  fs.appendFileSync(file, `${new Date().toISOString()},${phone},${status},${clean}\n`);
}
