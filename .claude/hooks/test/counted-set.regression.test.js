// HiveMind — execute-boundary COUNTED-SET regression test (item B1.5).
// .claude/hooks/test/counted-set.regression.test.js
//
// WHY THIS FILE EXISTS (separate from the classifier's own --selftest):
//   The execute-boundary classifier is pattern-based and was MEASURED wrong
//   once already — seven real heredoc file-writes counted ZERO while a `sed -i`
//   in the same turn counted correctly, silently voiding a security-relevant
//   CEILING for exactly the command shapes this harness tells operators to
//   prefer. The inline --selftest lives in the SAME file as the logic it
//   guards, so a revert of the counted-set widening reverts its selftest too.
//   This standalone test lives apart and runs in CI (see
//   .github/workflows/hooks-tests.yml), so the counted set is a MECHANICALLY
//   CHECKED property that a future edit to the classifier cannot silently
//   loosen.
//
// THE COUNTED SET = the file-writing / hands-on shapes isMutatingBash MUST
// count, plus the noise guards it must NOT. The write-shaped block below is
// the 2026-08-27 widening (redirects, tee, interpreter heredoc/-c/-e/stdin,
// truncate, dd of=, install). GATE (proven, see the file's git history / the
// task's RED-on-revert step): reverting that widening turns every row in
// WRITE_SHAPED_SHOULD_COUNT red.
//
// Run: node --test .claude/hooks/test/   (or this file directly).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  isMutatingBash,
  isMutatingToolCall,
} = require(path.join(__dirname, '..', 'lib', 'execute-boundary-classifier.js'));

// ── The WIDENED write-shaped rules (2026-08-27 counted-set hole). Each entry
// is a real file-writing command shape. This is the block that goes RED if the
// widening is reverted — the whole point of the regression.
const WRITE_SHAPED_SHOULD_COUNT = [
  // interpreter heredoc — the exact shape measured uncounted firsthand.
  ["heredoc interpreter write (python)", "python3 - <<'EOF'\np='x.ts'\nopen(p,'w').write(s)\nEOF"],
  ["heredoc interpreter write (node stdin)", "node - <<'EOF'\nrequire('fs').writeFileSync('a','b')\nEOF"],
  // interpreter inline code.
  ['python -c inline', 'python3 -c "open(\'a\',\'w\').write(\'b\')"'],
  ['node -e inline', `node -e "require('fs').writeFileSync('a','b')"`],
  ['perl -e inline', `perl -e 'open(F,">","a");print F "b"'`],
  ['ruby -e inline', `ruby -e 'File.write("a","b")'`],
  // shell redirects.
  ['> redirect', 'echo "x" > file.txt'],
  ['>> append redirect', 'echo "x" >> file.txt'],
  // tee.
  ['tee', 'cat in | tee out.txt'],
  ['tee -a', 'echo x | tee -a out.txt'],
  // direct file-write utilities.
  ['truncate', 'truncate -s 0 file.txt'],
  ['dd of=', 'dd if=/dev/zero of=file.txt bs=1M count=1'],
  ['install', 'install -m 644 file.txt /usr/local/bin/thing'],
];

// ── Pre-existing (non-widened) mutating shapes — kept in the counted set so a
// refactor that drops one is caught too.
const PREEXISTING_SHOULD_COUNT = [
  ['ssh with user@host', 'ssh user@host "ls"'],
  ['ssh with flag', 'ssh -i key.pem user@host'],
  ['scp', 'scp file.txt user@host:/tmp/'],
  ['docker run', 'docker run -d foo'],
  ['docker exec', 'docker exec -it foo bash'],
  ['docker compose up', 'docker compose up -d'],
  ['git commit', 'git commit -m "x"'],
  ['git push', 'git push'],
  ['git checkout -b', 'git checkout -b feat/x'],
  ['psql DML', 'psql -c "INSERT INTO foo VALUES (1)"'],
  ['sed -i', 'sed -i "s/a/b/" file.txt'],
  ['rm', 'rm -rf /tmp/x'],
  ['mv', 'mv a.txt b.txt'],
  ['cp', 'cp a.txt b.txt'],
  ['curl POST', 'curl -X POST https://x'],
  ['curl --data', 'curl --data "x=1" https://x'],
];

// ── Noise guards — reads / non-mutating shapes that MUST NOT count. The
// write-shaped widening deliberately over-counts on ambiguity, so these lock
// down the specific exclusions (stderr-merge, /dev/null sink, read verbs).
const SHOULD_NOT_COUNT = [
  ['ls', 'ls -la'],
  ['cat', 'cat file.txt'],
  ['git status', 'git status --short'],
  ['git diff', 'git diff'],
  ['git log', 'git log'],
  ['docker ps', 'docker ps'],
  ['docker logs', 'docker logs foo'],
  ['grep', 'grep -rn "foo" src/ 2>/dev/null'],
  ['psql SELECT', 'psql -c "SELECT * FROM foo"'],
  ['curl GET', 'curl https://x'],
  ['stderr-merge is not a file redirect', 'echo hi 2>&1'],
  ['/dev/null sink is not a file write', 'ls -la > /dev/null'],
];

test('write-shaped rules — every file-writing shape counts (RED on revert of the widening)', () => {
  for (const [label, cmd] of WRITE_SHAPED_SHOULD_COUNT) {
    assert.equal(isMutatingBash(cmd), true, `write-shaped MUST count: ${label} :: ${cmd}`);
  }
});

test('pre-existing mutating shapes still count', () => {
  for (const [label, cmd] of PREEXISTING_SHOULD_COUNT) {
    assert.equal(isMutatingBash(cmd), true, `pre-existing MUST count: ${label} :: ${cmd}`);
  }
});

test('noise guards — reads and non-writes do not count', () => {
  for (const [label, cmd] of SHOULD_NOT_COUNT) {
    assert.equal(isMutatingBash(cmd), false, `MUST NOT count: ${label} :: ${cmd}`);
  }
});

test('counted-set size is not silently shrunk', () => {
  // A blunt tripwire: if a future edit removes rules, these totals drop and the
  // assertion names exactly how much the counted set lost.
  assert.equal(WRITE_SHAPED_SHOULD_COUNT.length, 13, 'expected 13 write-shaped rows');
  assert.equal(PREEXISTING_SHOULD_COUNT.length, 16, 'expected 16 pre-existing rows');
  assert.equal(SHOULD_NOT_COUNT.length, 12, 'expected 12 noise-guard rows');
});

test('isMutatingToolCall — Edit/Write/MultiEdit always count, Bash delegates, reads never', () => {
  assert.equal(isMutatingToolCall('Edit', {}), true);
  assert.equal(isMutatingToolCall('Write', {}), true);
  assert.equal(isMutatingToolCall('MultiEdit', {}), true);
  assert.equal(isMutatingToolCall('Bash', { command: 'echo x > f' }), true);
  assert.equal(isMutatingToolCall('Bash', { command: 'git status' }), false);
  assert.equal(isMutatingToolCall('Read', {}), false);
  assert.equal(isMutatingToolCall('Grep', {}), false);
  assert.equal(isMutatingToolCall('mcp__engram__fos_memory', {}), false);
});
