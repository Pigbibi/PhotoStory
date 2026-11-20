import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import {
  THEME_STORAGE_KEY,
  THEMES,
  themeOrDefault,
  applyTheme,
  readStoredTheme,
  writeStoredTheme,
} from '../src/theme-core.mjs';

test('theme defaults to system and rejects invalid values', () => {
  assert.equal(THEME_STORAGE_KEY, 'photostory-theme');
  assert.deepEqual(THEMES, ['system', 'light', 'dark']);
  assert.equal(themeOrDefault(undefined), 'system');
  assert.equal(themeOrDefault(null), 'system');
  assert.equal(themeOrDefault('invalid'), 'system');
  assert.equal(themeOrDefault('light'), 'light');
  assert.equal(themeOrDefault('dark'), 'dark');
  assert.equal(themeOrDefault('system'), 'system');
});

test('applyTheme sets data-theme for explicit themes and removes it for system', () => {
  const attrs = new Map();
  const root = {
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
  };

  applyTheme('light', root);
  assert.equal(attrs.get('data-theme'), 'light');

  applyTheme('dark', root);
  assert.equal(attrs.get('data-theme'), 'dark');

  applyTheme('system', root);
  assert.equal(attrs.has('data-theme'), false);

  applyTheme('bogus', root);
  assert.equal(attrs.has('data-theme'), false);
});

test('readStoredTheme and writeStoredTheme handle storage safely', () => {
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };

  assert.equal(readStoredTheme(storage), 'system');
  writeStoredTheme('dark', storage);
  assert.equal(store.get('photostory-theme'), 'dark');
  assert.equal(readStoredTheme(storage), 'dark');

  writeStoredTheme('unknown', storage);
  assert.equal(store.get('photostory-theme'), 'system');

  const failingStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  assert.equal(readStoredTheme(failingStorage), 'system');
  assert.doesNotThrow(() => writeStoredTheme('light', failingStorage));
});

test('index.html loads synchronous external theme-init script before module script without inline scripts', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const headMatch = html.match(/<head>([\s\S]*?)<\/head>/i);
  assert.ok(headMatch, '<head> present');
  const head = headMatch[1];

  const initTagMatch = html.match(/<script\b[^>]*\bsrc="\/theme-init\.js"[^>]*>\s*<\/script>/i);
  assert.ok(initTagMatch, 'external /theme-init.js script tag present');
  assert.ok(head.includes(initTagMatch[0]), '/theme-init.js script is inside <head>');
  assert.doesNotMatch(initTagMatch[0], /\b(async|defer)\b/i, 'theme-init script must be synchronous');
  assert.doesNotMatch(initTagMatch[0], /\btype\s*=\s*["']?module/i, 'theme-init script must be classic');

  const initIdx = html.indexOf(initTagMatch[0]);
  const moduleIdx = html.indexOf('/src/main.jsx');
  assert.ok(moduleIdx !== -1, 'module script present');
  assert.ok(initIdx < moduleIdx, 'theme-init script runs before module script');

  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(
    ([, attrs, body]) => !/\bsrc\s*=/i.test(attrs) && body.trim().length > 0,
  );
  assert.equal(inlineScripts.length, 0, 'no inline scripts that would be blocked by script-src self CSP');

  const initSrc = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');
  assert.match(initSrc, /photostory-theme/);
  assert.match(initSrc, /data-theme/);
  assert.match(initSrc, /\btry\b[\s\S]*\bcatch\b/);

  const runInit = (storageGetter) => {
    const attrs = new Map([['data-theme', 'stale']]);
    const ctx = {
      document: {
        documentElement: {
          setAttribute: (k, v) => attrs.set(k, v),
          removeAttribute: (k) => attrs.delete(k),
        },
      },
    };
    Object.defineProperty(ctx, 'localStorage', { configurable: true, get: storageGetter });
    vm.runInNewContext(initSrc, ctx);
    return attrs;
  };

  assert.equal(runInit(() => ({ getItem: () => 'dark' })).get('data-theme'), 'dark');
  assert.equal(runInit(() => ({ getItem: () => 'light' })).get('data-theme'), 'light');
  assert.equal(runInit(() => ({ getItem: () => 'system' })).has('data-theme'), false);
  assert.equal(runInit(() => ({ getItem: () => null })).has('data-theme'), false);
  assert.doesNotThrow(() => runInit(() => { throw new Error('SecurityError'); }));
});

test('style.css supports explicit light/dark overrides and system preference fallback', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  const rootDarkMatch = css.match(/:root\s*\{([^}]*)\}/);
  assert.ok(rootDarkMatch, ':root block present');
  assert.match(rootDarkMatch[1], /color-scheme:\s*dark;/);

  const mediaLightMatch = css.match(
    /@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root:not\(\[data-theme="dark"\]\)\s*\{([^}]*)\}\s*\}/,
  );
  assert.ok(mediaLightMatch, 'prefers-color-scheme: light guarded by :not([data-theme="dark"])');

  const explicitLightMatch = css.match(/html\[data-theme="light"\]\s*\{([^}]*)\}/);
  assert.ok(explicitLightMatch, 'html[data-theme="light"] block present');

  const normalize = (block) => block.replace(/\s+/g, ' ').trim();
  assert.equal(normalize(explicitLightMatch[1]), normalize(mediaLightMatch[1]));
});

test('ThemeSwitcher renders three localized theme options matching the stored default', async (t) => {
  const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false } });
  t.after(() => vite.close());
  const { I18nProvider } = await vite.ssrLoadModule('/src/i18n.jsx');
  const { ThemeProvider, ThemeSwitcher } = await vite.ssrLoadModule('/src/theme.jsx');
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ThemeProvider, null, React.createElement(ThemeSwitcher)),
    ),
  );
  assert.match(html, /class="theme-switch"/);
  assert.match(html, /aria-label="Theme"/);
  assert.match(html, /<option value="system" selected="">System<\/option>/);
  assert.match(html, /<option value="light">Light<\/option>/);
  assert.match(html, /<option value="dark">Dark<\/option>/);
});
