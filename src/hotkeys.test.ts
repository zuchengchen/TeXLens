import { describe, expect, it } from "vitest";
import { hasTauriRuntime, normalizeGlobalShortcut } from "./hotkeys";

describe("normalizeGlobalShortcut", () => {
  it("normalizes common modifier aliases without changing the fallback", () => {
    expect(normalizeGlobalShortcut(" control + option + m ", "Ctrl+Alt+M")).toBe("Ctrl+Alt+M");
    expect(normalizeGlobalShortcut("cmdorctrl + shift + p", "Ctrl+Alt+M")).toBe("CommandOrControl+Shift+P");
  });

  it("falls back when the configured shortcut is empty", () => {
    expect(normalizeGlobalShortcut("   ", "Ctrl+Alt+M")).toBe("Ctrl+Alt+M");
  });
});

describe("hasTauriRuntime", () => {
  it("accepts both the Tauri marker and invoke internals", () => {
    expect(hasTauriRuntime({ isTauri: true })).toBe(true);
    expect(hasTauriRuntime({ __TAURI_INTERNALS__: {} })).toBe(true);
    expect(hasTauriRuntime({})).toBe(false);
  });
});
