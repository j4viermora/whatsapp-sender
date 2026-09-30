import type { Status } from '../types';

// The progress bar is only drawn in an interactive terminal
export const TTY = process.stdout.isTTY;

export const clock = (): string => new Date().toLocaleTimeString('es-AR');

export function duration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 1) return `${Math.round(sec)}s`;
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}min`;
}

export const mmss = (sec: number): string => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

const visibleLength = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, '').length;

// Prints a normal line without overwriting the bar
export function log(msg: string): void {
  if (TTY) process.stdout.write('\r\x1b[K');
  console.log(msg);
}

// Progress bar on the last terminal line. `estimate` returns the seconds needed for `left` messages.
export function createProgress(total: number, estimate: (left: number) => number) {
  const counts: Record<Status, number> = { enviado: 0, sin_whatsapp: 0, error: 0 };

  function show(done: number, extra = ''): void {
    if (!TTY) return;
    const pct = Math.round((done / total) * 100);
    const parts = {
      count: `${done}/${total} (${pct}%)`,
      stats: `\x1b[32m✓ ${counts.enviado}\x1b[0m  \x1b[33m⊘ ${counts.sin_whatsapp}\x1b[0m  \x1b[31m✗ ${counts.error}\x1b[0m`,
      eta: done < total ? `~${duration(estimate(total - done))} restantes` : '',
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

  return { counts, show };
}
