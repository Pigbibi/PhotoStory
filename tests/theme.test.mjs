import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('index.html runs the no-flash theme script before the module script', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const inlineIdx = html.indexOf('photostory-theme');
  const moduleIdx = html.indexOf('/src/main.jsx');
  assert.ok(inlineIdx !== -1, 'inline theme script present');
  assert.ok(moduleIdx !== -1, 'module script present');
  assert.ok(inlineIdx < moduleIdx, 'inline script runs before module script');
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
