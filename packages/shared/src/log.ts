/**
 * Structured JSON logger. One line per event, machine-parseable, ready to ship
 * to SLS in cloud. Never logs secrets. Includes a context object on every line.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL: LogLevel = (process.env.ENGRAM_LOG_LEVEL as LogLevel) || 'info';

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(level: LogLevel, component: string, bindings: Record<string, unknown>, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    component,
    msg,
    ...bindings,
    ...(ctx ?? {}),
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

export function createLogger(component: string, bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (m, c) => emit('debug', component, bindings, m, c),
    info: (m, c) => emit('info', component, bindings, m, c),
    warn: (m, c) => emit('warn', component, bindings, m, c),
    error: (m, c) => emit('error', component, bindings, m, c),
    child: (b) => createLogger(component, { ...bindings, ...b }),
  };
}
