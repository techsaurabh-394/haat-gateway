const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = keyof typeof LEVELS;

function currentLevel(): Level {
  const v = process.env.HAAT_LOG as Level | undefined;
  return v && v in LEVELS ? v : 'warn';
}

function out(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < LEVELS[currentLevel()]) return;
  const line = `[${new Date().toISOString()}] ${level.padEnd(5)} ${scope}: ${msg}`;
  if (extra !== undefined) console.error(line, extra);
  else console.error(line);
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => out('debug', scope, m, e),
    info: (m: string, e?: unknown) => out('info', scope, m, e),
    warn: (m: string, e?: unknown) => out('warn', scope, m, e),
    error: (m: string, e?: unknown) => out('error', scope, m, e),
  };
}
