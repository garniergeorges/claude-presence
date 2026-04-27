type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentLevel(): Level {
  const env = (process.env.LOG_LEVEL || "info").toLowerCase();
  if (env in LEVELS) return env as Level;
  return "info";
}

function shouldLog(level: Level): boolean {
  return LEVELS[level] >= LEVELS[currentLevel()];
}

function emit(level: Level, message: string, fields?: Record<string, unknown>) {
  if (!shouldLog(level)) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  };
  // Always to stderr so stdout stays clean for any future piping use
  process.stderr.write(JSON.stringify(line) + "\n");
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) =>
    emit("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) =>
    emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) =>
    emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) =>
    emit("error", message, fields),
};
