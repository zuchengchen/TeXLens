const modifierAliases = new Map<string, string>([
  ["OPTION", "Alt"],
  ["ALT", "Alt"],
  ["CONTROL", "Ctrl"],
  ["CTRL", "Ctrl"],
  ["COMMAND", "Command"],
  ["CMD", "Command"],
  ["SUPER", "Super"],
  ["SHIFT", "Shift"],
  ["COMMANDORCONTROL", "CommandOrControl"],
  ["COMMANDORCTRL", "CommandOrControl"],
  ["CMDORCTRL", "CommandOrControl"],
  ["CMDORCONTROL", "CommandOrControl"],
]);

export function normalizeGlobalShortcut(value: string, fallback: string): string {
  const normalized = value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(normalizeShortcutToken)
    .join("+");
  return normalized || fallback;
}

export function hasTauriRuntime(runtime: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): boolean {
  return Boolean(runtime.__TAURI_INTERNALS__ || runtime.isTauri);
}

function normalizeShortcutToken(token: string): string {
  const modifier = modifierAliases.get(token.replaceAll(/\s/g, "").toUpperCase());
  if (modifier) return modifier;
  if (/^[a-z]$/i.test(token)) return token.toUpperCase();
  return token;
}
