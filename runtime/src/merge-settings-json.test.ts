// merge-settings-json.test.ts — unit + CLI tests for scripts/merge-settings-json.mjs,
// the deep-merge helper install.sh now uses to write $HIVEMIND_HOME/.claude/settings.json.
//
// WHY: install.sh used to `sed ... > settings.json` unconditionally — a
// full-file OVERWRITE that silently deleted whatever the user had added on top
// of the shipped defaults (extra permissions.allow/deny entries via /config, a
// custom hook, etc.) on every re-install. These tests prove the replacement
// (deep-merge) preserves the user's pre-existing entries while still applying
// the freshly-templated ones.
//
// The module lives at the repo ROOT (scripts/), not under runtime/, because
// install.sh invokes it directly from SCRIPT_DIR before `bun install` ever
// runs — same cross-repo-root import pattern as hivemind-cli.test.ts uses for
// bin/hivemind.
import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deepMergeSettings, mergeSettingsJsonText } from '../../scripts/merge-settings-json.mjs';

const testRoot = mkdtempSync(join(tmpdir(), 'hivemind-merge-settings-'));

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

test('deepMergeSettings preserves an existing top-level key the template does not know about', () => {
  const existing = { someFutureSetting: 'user-added', permissions: { allow: [] } };
  const template = { permissions: { allow: ['Read(**)'] } };
  const merged = deepMergeSettings(existing, template) as Record<string, unknown>;
  expect(merged.someFutureSetting).toBe('user-added');
});

test('deepMergeSettings unions arrays — a user-added permissions.allow entry survives alongside the template ones', () => {
  const existing = { permissions: { allow: ['Bash(git status)', 'Bash(my-custom-tool *)'] } };
  const template = { permissions: { allow: ['Bash(git status)', 'Read(**)', 'Write(**)'] } };
  const merged = deepMergeSettings(existing, template) as { permissions: { allow: string[] } };
  // Template entries all present.
  expect(merged.permissions.allow).toContain('Bash(git status)');
  expect(merged.permissions.allow).toContain('Read(**)');
  expect(merged.permissions.allow).toContain('Write(**)');
  // User's custom addition survives.
  expect(merged.permissions.allow).toContain('Bash(my-custom-tool *)');
  // No duplicate of the entry present in both.
  expect(merged.permissions.allow.filter((e) => e === 'Bash(git status)')).toHaveLength(1);
});

test('deepMergeSettings unions hook groups — a user-added hooks.PostToolUse entry survives alongside the shipped one', () => {
  const existing = {
    hooks: {
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'my-custom-hook.js' }] }],
    },
  };
  const template = {
    hooks: {
      PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|Bash', hooks: [{ type: 'command', command: 'shipped-hook.js' }] }],
    },
  };
  const merged = deepMergeSettings(existing, template) as {
    hooks: { PostToolUse: Array<{ matcher: string }> };
  };
  expect(merged.hooks.PostToolUse).toHaveLength(2);
  expect(merged.hooks.PostToolUse.some((g) => g.matcher === 'Edit')).toBe(true);
  expect(merged.hooks.PostToolUse.some((g) => g.matcher === 'Edit|Write|MultiEdit|Bash')).toBe(true);
});

test('deepMergeSettings re-applies the template value for a scalar even when the existing file disagrees', () => {
  const existing = { permissions: { defaultMode: 'ask' }, skipDangerousModePermissionPrompt: false };
  const template = { permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true };
  const merged = deepMergeSettings(existing, template) as {
    permissions: { defaultMode: string };
    skipDangerousModePermissionPrompt: boolean;
  };
  expect(merged.permissions.defaultMode).toBe('bypassPermissions');
  expect(merged.skipDangerousModePermissionPrompt).toBe(true);
});

test('deepMergeSettings does not duplicate an array entry that is structurally identical (idempotent re-merge)', () => {
  const existing = { permissions: { allow: ['Read(**)', 'Write(**)'] } };
  const template = { permissions: { allow: ['Read(**)', 'Write(**)'] } };
  const merged = deepMergeSettings(existing, template) as { permissions: { allow: string[] } };
  expect(merged.permissions.allow).toEqual(['Read(**)', 'Write(**)']);
});

test('mergeSettingsJsonText treats a corrupted existing document as absent — falls back to the template, never throws', () => {
  const merged = mergeSettingsJsonText('{ this is not valid json', JSON.stringify({ permissions: { allow: ['Read(**)'] } }));
  expect(merged).toEqual({ permissions: { allow: ['Read(**)'] } });
});

test('mergeSettingsJsonText treats a top-level non-object (null) existing document as absent, same guard as setup.ts .claude.json', () => {
  const merged = mergeSettingsJsonText('null', JSON.stringify({ permissions: { allow: ['Read(**)'] } }));
  expect(merged).toEqual({ permissions: { allow: ['Read(**)'] } });
});

test('mergeSettingsJsonText with existingText=null (no pre-existing file, fresh install) returns exactly the template', () => {
  const template = { permissions: { allow: ['Read(**)'] }, statusLine: { command: 'x' } };
  const merged = mergeSettingsJsonText(null, JSON.stringify(template));
  expect(merged).toEqual(template);
});

// ── CLI integration — proves install.sh's actual invocation shape works ─────
// (`bun run merge-settings-json.mjs <targetPath> <templatePath>`, writing the
// merged result back to targetPath).
test('CLI: merges an on-disk existing settings.json with a freshly-templated one, preserving the users extra entries', () => {
  const scriptPath = join(import.meta.dir, '..', '..', 'scripts', 'merge-settings-json.mjs');
  const targetPath = join(testRoot, 'settings.json');
  const templatePath = join(testRoot, 'template.json');

  writeFileSync(
    targetPath,
    JSON.stringify({
      permissions: { allow: ['Bash(git status)', 'Bash(my-custom-tool *)'], defaultMode: 'ask' },
      someUserAddedTopLevelKey: 'keep-me',
    }),
  );
  writeFileSync(
    templatePath,
    JSON.stringify({
      permissions: { allow: ['Bash(git status)', 'Read(**)'], defaultMode: 'bypassPermissions' },
      statusLine: { type: 'command', command: '/home/user/.hivemind/bin/hivemind-statusline.py' },
    }),
  );

  const res = Bun.spawnSync(['bun', 'run', scriptPath, targetPath, templatePath], { stdout: 'pipe', stderr: 'pipe' });
  expect(res.exitCode).toBe(0);

  const merged = JSON.parse(readFileSync(targetPath, 'utf8'));
  expect(merged.someUserAddedTopLevelKey).toBe('keep-me');
  expect(merged.permissions.allow).toContain('Bash(my-custom-tool *)');
  expect(merged.permissions.allow).toContain('Read(**)');
  // Scalar re-applies the template's latest value.
  expect(merged.permissions.defaultMode).toBe('bypassPermissions');
  expect(merged.statusLine.command).toBe('/home/user/.hivemind/bin/hivemind-statusline.py');
});

test('CLI: first install (no pre-existing target file) writes exactly the templated content', () => {
  const scriptPath = join(import.meta.dir, '..', '..', 'scripts', 'merge-settings-json.mjs');
  const targetPath = join(testRoot, 'fresh-settings.json');
  const templatePath = join(testRoot, 'fresh-template.json');
  const template = { permissions: { allow: ['Read(**)'] }, skipDangerousModePermissionPrompt: true };
  writeFileSync(templatePath, JSON.stringify(template));

  const res = Bun.spawnSync(['bun', 'run', scriptPath, targetPath, templatePath], { stdout: 'pipe', stderr: 'pipe' });
  expect(res.exitCode).toBe(0);

  const written = JSON.parse(readFileSync(targetPath, 'utf8'));
  expect(written).toEqual(template);
});
