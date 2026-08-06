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
//   - arrays: TEMPLATE-OWNED WITH REVOCATION (code-review fix — see below),
//     not a pure union. The template's own entries are always present;
//     existing entries are kept ONLY if they are not already covered by the
//     template AND were not part of the PREVIOUS template shipment (the
//     `previousTemplate` parameter) — i.e. only genuinely user-added entries
//     survive. An entry the template shipped before and has since dropped is
//     revoked, not re-added forever.
//   - scalars (strings/numbers/booleans/null): the TEMPLATE value wins — these
//     are operational keys tied to the shipped runtime (statusLine command path,
//     defaultMode, hook command lines) and must track the shipped version, not
//     drift from a stale local edit.
//
// A corrupted or non-object existing file is treated as absent ({}) — merging
// then degrades to "just the template", the same as a fresh install. This never
// aborts the install.
//
// ── Revocation semantics (code-review fix, debit-free) ──────────────────────
// The OLD array rule was a pure union-with-dedup: template ∪ existing, nothing
// ever removed. That has one real bug: once ANY permission/hook ships in the
// template, it can NEVER be revoked by a later install/update — the existing
// file forever re-contributes it back into the union. There is no way to tell,
// from (existing, template) alone, whether an array entry present in `existing`
// but absent from the new `template` is (a) an entry the template used to ship
// and has since intentionally dropped (should be REVOKED) or (b) an entry the
// USER typed in themselves and the template never knew about (must SURVIVE).
// Distinguishing them needs a third input: what the template looked like LAST
// time this ran. That's `previousTemplate` — a snapshot of the exact template
// object used on the previous merge, persisted by the CLI entry point below
// (alongside the target file, `<targetPath>.template-snapshot.json`) and fed
// back in on the next run.
//   - previousTemplate absent (first run under this scheme, or the snapshot
//     file itself is missing/corrupted): fully conservative — behaves exactly
//     like the old pure-union rule (nothing is dropped). This is the correct,
//     honest degrade: without a baseline there is no way to tell "shipped-then-
//     removed" from "user-added", so the safe default is to keep everything, at
//     the cost of one bootstrap install where revocation doesn't yet apply.
//   - previousTemplate present: an existing entry not already covered by the
//     current template is kept ONLY if it is also absent from previousTemplate
//     (i.e. it was never something the template shipped) — otherwise it's a
//     template-owned entry the new template chose to stop shipping, and it is
//     dropped.
// This applies recursively per array, at whatever object path it lives under,
// so the same rule protects `permissions.allow`, `permissions.deny`,
// `hooks.PostToolUse`, etc. without hardcoding any of those paths by name.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * @param {unknown} existing
 * @param {unknown} template
 * @param {unknown} [previousTemplate] - the template as it looked on the
 *   PREVIOUS merge (same shape as `template`), or undefined if unknown —
 *   see "Revocation semantics" above. Recurses alongside existing/template.
 * @returns {unknown}
 */
export function deepMergeSettings(existing, template, previousTemplate) {
  if (Array.isArray(template)) {
    const base = Array.isArray(existing) ? existing : [];
    const prevTemplateArr = Array.isArray(previousTemplate) ? previousTemplate : undefined;
    const merged = [...template];
    const inMerged = (item) => {
      const itemStr = JSON.stringify(item);
      return merged.some((m) => JSON.stringify(m) === itemStr);
    };
    const wasPreviouslyTemplateOwned = (item) => {
      if (!prevTemplateArr) return false; // unknown baseline → never revoke
      const itemStr = JSON.stringify(item);
      return prevTemplateArr.some((p) => JSON.stringify(p) === itemStr);
    };
    for (const item of base) {
      if (inMerged(item)) continue; // already present via the current template
      if (wasPreviouslyTemplateOwned(item)) continue; // shipped-then-removed → revoke
      merged.push(item); // genuinely user-added (or baseline unknown) → keep
    }
    return merged;
  }
  if (template && typeof template === 'object') {
    const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
    const prevBase =
      previousTemplate && typeof previousTemplate === 'object' && !Array.isArray(previousTemplate)
        ? previousTemplate
        : {};
    /** @type {Record<string, unknown>} */
    const merged = { ...base };
    for (const key of Object.keys(template)) {
      merged[key] = deepMergeSettings(base[key], template[key], prevBase[key]);
    }
    return merged;
  }
  // Scalar (or template is null) — the template's value always wins.
  return template;
}

/**
 * @param {string | null} existingText - null/absent → treated as {}.
 * @param {string} templateText - required, must be valid JSON.
 * @param {string | null} [previousTemplateText] - null/absent/corrupted →
 *   treated as "no baseline" (fully conservative union, see module docstring).
 * @returns {unknown}
 */
export function mergeSettingsJsonText(existingText, templateText, previousTemplateText) {
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
  let previousTemplate;
  if (previousTemplateText != null) {
    try {
      const parsedPrev = JSON.parse(previousTemplateText);
      if (parsedPrev && typeof parsedPrev === 'object' && !Array.isArray(parsedPrev)) {
        previousTemplate = parsedPrev;
      }
      // Corrupted/non-object snapshot → previousTemplate stays undefined,
      // same conservative "no baseline" degrade as a missing snapshot file.
    } catch {
      /* corrupted snapshot → no baseline */
    }
  }
  const template = JSON.parse(templateText);
  return deepMergeSettings(existing, template, previousTemplate);
}

// CLI entry: bun run merge-settings-json.mjs <targetPath> <templatePath>
// Reads targetPath (if present) + templatePath, writes the merged result back
// to targetPath. Also reads/writes a sidecar snapshot of the template used on
// THIS run (`<targetPath>.template-snapshot.json`) — the baseline the NEXT
// invocation needs to tell "the template used to ship this, now doesn't"
// (revoke) apart from "the user typed this, the template never knew about it"
// (keep). See the revocation-semantics docstring above.
if (import.meta.main) {
  const [targetPath, templatePath] = process.argv.slice(2);
  if (!targetPath || !templatePath) {
    console.error('usage: merge-settings-json.mjs <targetPath> <templatePath>');
    process.exit(1);
  }
  const snapshotPath = `${targetPath}.template-snapshot.json`;
  const existingText = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null;
  const templateText = readFileSync(templatePath, 'utf8');
  const previousTemplateText = existsSync(snapshotPath) ? readFileSync(snapshotPath, 'utf8') : null;
  const merged = mergeSettingsJsonText(existingText, templateText, previousTemplateText);
  writeFileSync(targetPath, `${JSON.stringify(merged, null, 2)}\n`);
  // Persist THIS run's template as next run's baseline. Written after the
  // merge succeeds, from the same templateText already validated above.
  writeFileSync(snapshotPath, templateText);
}
