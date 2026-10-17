// Platform-aware key labels for hints and the shortcut sheet.
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modKey = isMac ? "⌘" : "Ctrl+";
export const modLabel = isMac ? "⌘" : "Ctrl";
