import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useI18n } from './i18n.jsx';
import { applyTheme, readStoredTheme, writeStoredTheme } from './theme-core.mjs';

const Context = createContext(null);

const THEME_OPTIONS = [
  ['system', '跟随系统'],
  ['light', '浅色'],
  ['dark', '深色'],
];

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => readStoredTheme());
  useEffect(() => {
    applyTheme(theme);
    writeStoredTheme(theme);
  }, [theme]);
  const value = useMemo(() => ({ theme, setTheme }), [theme]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useTheme = () => useContext(Context);

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();
  return (
    <select
      className="theme-switch"
      aria-label={t('界面主题')}
      value={theme}
      onChange={(e) => setTheme(e.target.value)}
    >
      {THEME_OPTIONS.map(([value, label]) => (
        <option key={value} value={value}>
          {t(label)}
        </option>
      ))}
    </select>
  );
}
