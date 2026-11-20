export const THEME_STORAGE_KEY = 'photostory-theme';
export const THEMES = ['system', 'light', 'dark'];

export function themeOrDefault(value) {
  return THEMES.includes(value) ? value : 'system';
}

export function applyTheme(theme, root = globalThis.document?.documentElement) {
  if (!root) return;
  const resolved = themeOrDefault(theme);
  if (resolved === 'light' || resolved === 'dark') {
    root.setAttribute('data-theme', resolved);
  } else {
    root.removeAttribute('data-theme');
  }
}

export function readStoredTheme(storage = globalThis.localStorage) {
  try {
    return themeOrDefault(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function writeStoredTheme(theme, storage = globalThis.localStorage) {
  try {
    storage?.setItem(THEME_STORAGE_KEY, themeOrDefault(theme));
  } catch {}
}
