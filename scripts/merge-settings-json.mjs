#!/usr/bin/env bun
// merge-settings-json.mjs — deep-merge helper for $HIVEMIND_HOME/.claude/settings.json.
//
// WHY THIS EXISTS (founder report): install.sh used to `sed ... > settings.json`
// unconditionally — a full-file OVERWRITE. On a fresh install that's fine (there
// is nothing to lose), but on a RE-install it silently deleted whatever the user
// had added on top of the shipped defaults (extra permissions.allow entries via
// /config, a custom hook, etc.), forcing full reconfiguration every time. This
// module deep-merges the existing on-disk file with the freshly-templated one:
//
//   - objects merge key-by-key: the existing object's keys are the base, and
//     every key the TEMPLATE defines is recursively merged in — so a
//     user-added top-level/nested key that the template doesn't know about
//     (e.g. a future "env" block, a custom top-level setting) survives untouched.
//   - arrays UNION with dedup: template entries first, then any existing entries
//     not already structurally present (JSON-equal) are appended — so a
//     user-added permissions.allow/deny entry, or an extra hooks group, is never
//     dropped, while the template's own entries are guaranteed present.
//   - scalars (strings/numbers/booleans/null): the TEMPLATE value wins — these
//     are operational keys tied to the shipped runtime (statusLine command path,
//     defaultMode, hook command lines) and must track the shipped version, not
//     drift from a stale local edit.
//
// A corrupted or non-object existing file is treated as absent ({}) — merging
// then degrades to "just the template", the same as a fresh install. This never
// aborts the install.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * @param {unknown} existing
 * @param {unknown} template
 * @returns {unknown}
 */
export function deepMergeSettings(existing, template) {
  if (Array.isArray(template)) {
    const base = Array.isArray(existing) ? existing : [];
    const merged = [...template];
    for (const item of base) {
      const itemStr = JSON.stringify(item);
      if (!merged.some((m) => JSON.stringify(m) === itemStr)) merged.push(item);
    }
    return merged;
  }
  if (template && typeof template === 'object') {
    const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
    /** @type {Record<string, unknown>} */
    const merged = { ...base };
    for (const key of Object.keys(template)) {
      merged[key] = deepMergeSettings(base[key], template[key]);
    }
    return merged;
  }
  // Scalar (or template is null) — the template's value always wins.
  return template;
}

/**
 * @param {string | null} existingText - null/absent → treated as {}.
 * @param {string} templateText - required, must be valid JSON.
 * @returns {unknown}
 */
export function mergeSettingsJsonText(existingText, templateText) {
  let existing = {};
  if (existingText != null) {
    try {
      const parsed = JSON.parse(existingText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed;
      }
      // A syntactically-valid but non-object JSON document (null/array/scalar)
      // also falls back to {} — same guard as setup.ts's .claude.json merge.
    } catch {
      // Corrupted existing file → treat as absent, never abort the install.
    }
  }
  const template = JSON.parse(templateText);
  return deepMergeSettings(existing, template);
}

// CLI entry: bun run merge-settings-json.mjs <targetPath> <templatePath>
// Reads targetPath (if present) + templatePath, writes the merged result back
// to targetPath.
if (import.meta.main) {
  const [targetPath, templatePath] = process.argv.slice(2);
  if (!targetPath || !templatePath) {
    console.error('usage: merge-settings-json.mjs <targetPath> <templatePath>');
    process.exit(1);
  }
  const existingText = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null;
  const templateText = readFileSync(templatePath, 'utf8');
  const merged = mergeSettingsJsonText(existingText, templateText);
  writeFileSync(targetPath, `${JSON.stringify(merged, null, 2)}\n`);
}
