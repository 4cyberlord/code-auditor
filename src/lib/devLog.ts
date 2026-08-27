const ENABLED_STORAGE_KEY = "codeEditorDevLog";

export function devLog(scope: string, message: string, data?: unknown) {
  if (typeof window === "undefined") return;
  const enabled =
    process.env.NODE_ENV === "development" ||
    window.localStorage.getItem(ENABLED_STORAGE_KEY) === "1";
  if (!enabled) return;
  const stamp = new Date().toISOString();
  if (data === undefined) console.info(`[Code Editor dev ${stamp}] ${scope}: ${message}`);
  else console.info(`[Code Editor dev ${stamp}] ${scope}: ${message}`, data);
}
