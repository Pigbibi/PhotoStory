export const THEME_STORAGE_KEY = 'photostory-theme';
export const THEMES = ['system', 'light', 'dark'];

export function themeOrDefault(value) {
  return THEMES.includes(value) ? value : 'system';
}

export function applyTheme(theme, root) {
  try {
    const target = root === undefined ? globalThis.document?.documentElement : root;
    if (!target) return;
    const resolved = themeOrDefault(theme);
    if (resolved === 'light' || resolved === 'dark') {
      target.setAttribute('data-theme', resolved);
    } else {
      target.removeAttribute('data-theme');
    }
  } catch {}
}

export function readStoredTheme(storage) {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    return themeOrDefault(target?.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function writeStoredTheme(theme, storage) {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    target?.setItem(THEME_STORAGE_KEY, themeOrDefault(theme));
  } catch {}
}
