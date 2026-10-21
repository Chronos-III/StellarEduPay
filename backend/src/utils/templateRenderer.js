'use strict';

/**
 * Minimal external-template loader and renderer shared by the email services
 * (Issue #80 — "Templates externalized and tested").
 *
 * Templates live under backend/src/templates/. Supported syntax:
 *   {{key}}                       — substituted with vars[key] ('' when nullish);
 *                                   HTML-escaped when rendering an HTML template
 *   {{{key}}}                     — raw substitution, never escaped. Only for
 *                                   values that are trusted HTML (Issue #1543)
 *   {{#if key}}…{{/if}}           — block included only when vars[key] is truthy
 *
 * Loaded template files are cached in-process; pass `fresh: true` to bypass the
 * cache (used in tests).
 */

const fs = require('fs');
const path = require('path');
const { t, translations } = require('../services/i18n');
const { escapeHtml } = require('./escapeHtml');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const _cache = new Map();

/**
 * Build `{{i18n_<key>}}` vars for every key in the given locale's translation
 * dict. Unsupported locales fall back to English (handled by `t()` itself).
 */
function buildI18nVars(locale) {
  const out = {};
  for (const key of Object.keys(translations.en)) {
    out[`i18n_${key}`] = t(locale, key);
  }
  return out;
}

function loadTemplate(filename, { fresh = false } = {}) {
  if (!fresh && _cache.has(filename)) return _cache.get(filename);
  const contents = fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf8');
  _cache.set(filename, contents);
  return contents;
}

/**
 * Render a template string.
 * @param {string} template
 * @param {object} vars
 * @param {object} [options]
 * @param {boolean} [options.escape=false] - HTML-escape every {{key}} value.
 *   {{{key}}} is always substituted raw.
 */
function renderTemplate(template, vars = {}, { escape = false } = {}) {
  const withConditionals = template.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, key, inner) => (vars[key] ? inner : '')
  );
  const value = (key) => (vars[key] != null ? String(vars[key]) : '');
  // Single pass so substituted values are never re-scanned for placeholders.
  return withConditionals.replace(/\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}/g, (_, rawKey, key) => {
    if (rawKey) return value(rawKey);
    return escape ? escapeHtml(value(key)) : value(key);
  });
}

// Only plain hex colours are allowed into inline `style` attributes; anything
// else (e.g. "red;background:url(...)") falls back to the default brand colour.
const SAFE_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const DEFAULT_PRIMARY_COLOR = '#1a56db';

/**
 * Load `name.txt` and `name.html` and render both with the same vars.
 * When `vars.locale` is set, `{{i18n_<key>}}` placeholders are populated from
 * the matching locale's translations (falling back to English for an
 * unsupported locale or a missing key).
 * @returns {{text: string, html: string}}
 */
function renderEmailTemplate(name, vars, opts = {}) {
  const merged = { ...buildI18nVars(vars.locale || 'en'), ...vars };
  const htmlVars = merged.primaryColor && !SAFE_COLOR_RE.test(merged.primaryColor)
    ? { ...merged, primaryColor: DEFAULT_PRIMARY_COLOR }
    : merged;
  return {
    text: renderTemplate(loadTemplate(`${name}.txt`, opts), merged),
    // Issue #1543: every substitution into the HTML variant is escaped by default.
    html: renderTemplate(loadTemplate(`${name}.html`, opts), htmlVars, { escape: true }),
  };
}

module.exports = { loadTemplate, renderTemplate, renderEmailTemplate, TEMPLATES_DIR };
