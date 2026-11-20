import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { applyTheme, readStoredTheme, writeStoredTheme } from './theme-core.mjs';

const Context = createContext(null);

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
