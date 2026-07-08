// routes/setup.ts — first-login mTLS enrollment popup.
//
// Companion to bin/fos-beta-enroll (B2, cross-repo — 4tuenyOS) which mints the
// enrollment token server-side. Token contract (against POST /ca/issue on
// kernel.silken.ia.br:4443):
//
//   Request:  POST /ca/issue  body: { token: string, csr_pem: string }
//   Response: { cert_pem: string, ca_cert_pem: string }
//
// NOTE: /ca/issue does NOT require a client cert — it validates the enrollment
// token directly (token is the authorization mechanism at enrollment time).
// After enrollment, the issued cert is used for all subsequent mTLS connections.
//
// SIGNAL: B2 (fos-beta-enroll) is being built concurrently. This handler codes
// against the expected contract above. If the /ca/issue response shape differs,
// update the caData destructure and error messaging accordingly.

import { Hono } from 'hono';
import { existsSync, mkdirSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const setupRouter = new Hono();

// In-memory flag: true once enrollment completes in this server lifetime.
// Used by GET /setup/status for the CLI to poll.
let enrollmentDone = false;

// ── GET /setup — HTML enrollment form ─────────────────────────────────────────

setupRouter.get('/', (c) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HiveMind — First Setup</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f1117; color: #e1e4e8; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 2rem; width: 100%; max-width: 440px; }
    h1 { font-size: 1.4rem; margin-bottom: 0.25rem; color: #58a6ff; }
    .sub { color: #8b949e; font-size: 0.875rem; margin-bottom: 1.5rem; }
    label { display: block; font-size: 0.8rem; color: #8b949e; margin-bottom: 0.25rem; margin-top: 1rem; }
    input { width: 100%; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 0.5rem 0.75rem; color: #e1e4e8; font-size: 0.9rem; font-family: inherit; }
    input:focus { outline: none; border-color: #58a6ff; }
    button { margin-top: 1.5rem; width: 100%; background: #1f6feb; border: none; border-radius: 6px; padding: 0.625rem; color: #fff; font-size: 0.9rem; cursor: pointer; font-weight: 600; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    #log { margin-top: 1rem; font-size: 0.8rem; }
    .step { padding: 0.2rem 0; color: #8b949e; }
    .step.ok { color: #3fb950; }
    .step.err { color: #f85149; }
    .go { margin-top: 1rem; padding: 0.75rem; background: #1a3a1a; border: 1px solid #3fb950; border-radius: 6px; color: #3fb950; font-size: 0.85rem; line-height: 1.5; }
    .nogo { margin-top: 1rem; padding: 0.75rem; background: #3a1a1a; border: 1px solid #f85149; border-radius: 6px; color: #f85149; font-size: 0.85rem; }
    code { background: #0d1117; padding: 0.1rem 0.3rem; border-radius: 3px; font-family: monospace; }
  </style>
</head>
<body>
  <div class="card">
    <h1>HiveMind</h1>
    <p class="sub">Configure your personal certificate to connect to memory.</p>
    <label for="token">Enrollment Token</label>
    <input type="password" id="token" placeholder="Paste the token sent by your admin" autocomplete="off">
    <label for="owner">Owner ID</label>
    <input type="text" id="owner" placeholder="e.g. beta-joao" autocomplete="off">
    <button id="btn" onclick="enroll()">Configure mTLS</button>
    <div id="log"></div>
  </div>
  <script>
    async function enroll() {
      const token = document.getElementById('token').value.trim();
      const owner = document.getElementById('owner').value.trim();
      const log = document.getElementById('log');
      const btn = document.getElementById('btn');
      if (!token || !owner) { step('Token and Owner ID are required.', 'err'); return; }
      btn.disabled = true;
      log.innerHTML = '';
      step('Sending enrollment request...', '');
      try {
        const res = await fetch('/setup/enroll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, owner_id: owner })
        });
        const data = await res.json();
        if (data.ok) {
          step('Keypair generated (EC P-256)', 'ok');
          step('CSR submitted to CA', 'ok');
          step('Certificate received and saved', 'ok');
          step('Proxy configuration written', 'ok');
          log.innerHTML += '<div class="go">GO — Certificate configured.<br>Close this tab and run <code>hivemind</code> in your project directory.</div>';
        } else {
          step('Error: ' + (data.message || 'unknown error'), 'err');
          log.innerHTML += '<div class="nogo">NO-GO — ' + escHtml(data.message || 'Enrollment failed.') + '</div>';
          btn.disabled = false;
        }
      } catch (err) {
        step('Network error: ' + err.message, 'err');
        btn.disabled = false;
      }
    }
    function step(msg, cls) {
      const d = document.createElement('div');
      d.className = 'step' + (cls ? ' ' + cls : '');
      d.textContent = msg;
      document.getElementById('log').appendChild(d);
    }
    function escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
  </script>
</body>
</html>`;
  return c.html(html);
});

// ── POST /setup/enroll — enrollment handler ────────────────────────────────────
//
// Steps:
//  1. Validate body (token + owner_id required)
//  2. Generate EC keypair + CSR via openssl (Bun.spawnSync)
//  3. POST /ca/issue → { cert_pem, ca_cert_pem }
//  4. Save key + cert + CA to ~/.fos/mtls/ (chmod 0600)
//  5. Write $HIVEMIND_HOME/.env with MTLS_* vars
//  6. Write ~/.claude/mcp.json (try) or ~/.mcp.json (fallback)
//  7. Return { ok: true, owner_id }

setupRouter.post('/enroll', async (c) => {
  let body: { token?: string; owner_id?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, message: 'Invalid JSON body' }, 400);
  }

  const { token, owner_id: ownerId } = body;
  if (!token || !ownerId) {
    return c.json({ ok: false, message: 'token and owner_id are required' }, 400);
  }

  // Sanitize owner_id: only alphanumeric, dash, underscore (CN-safe).
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(ownerId)) {
    return c.json({ ok: false, message: 'owner_id must be alphanumeric with dashes/underscores, max 64 chars' }, 400);
  }

  const hivemindHome = process.env.HIVEMIND_HOME ?? join(homedir(), '.hivemind');
  const mtlsDir = join(homedir(), '.fos', 'mtls');

  try {
    // 1. Prepare dirs.
    mkdirSync(hivemindHome, { recursive: true });
    mkdirSync(mtlsDir, { recursive: true });
    chmodSync(mtlsDir, 0o700);

    const keyPath  = join(mtlsDir, `${ownerId}.key.pem`);
    const csrPath  = join(mtlsDir, `${ownerId}.csr.pem`);
    const certPath = join(mtlsDir, `${ownerId}.cert.pem`);
    const caPath   = join(mtlsDir, 'ca.cert.pem');

    // 2. Generate EC keypair + CSR via openssl.
    const opensslResult = Bun.spawnSync([
      'openssl', 'req',
      '-newkey', 'ec',
      '-pkeyopt', 'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout', keyPath,
      '-out', csrPath,
      '-subj', `/CN=${ownerId}`,
    ], {
      stdout: 'ignore',
      stderr: 'pipe',
    });

    if (opensslResult.exitCode !== 0) {
      const errMsg = opensslResult.stderr?.toString() ?? 'unknown openssl error';
      return c.json({ ok: false, message: `openssl failed: ${errMsg.trim().slice(0, 300)}` }, 500);
    }
    chmodSync(keyPath, 0o600);

    // 3. Read CSR and post to CA.
    const csrPem = await Bun.file(csrPath).text();
    if (!csrPem || csrPem.trim().length === 0) {
      return c.json({ ok: false, message: 'CSR file empty after openssl — check openssl installation' }, 500);
    }

    const caUrl = 'https://kernel.silken.ia.br:4443/ca/issue';
    let caRes: Response;
    try {
      // No client cert here — /ca/issue validates via enrollment token.
      caRes = await fetch(caUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, csr_pem: csrPem }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (fetchErr: unknown) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      return c.json({ ok: false, message: `Cannot reach CA at ${caUrl}: ${msg}` }, 502);
    }

    if (!caRes.ok) {
      const errBody = await caRes.text().catch(() => '');
      return c.json({
        ok: false,
        message: `CA returned HTTP ${caRes.status}: ${errBody.slice(0, 300)}`,
      }, 502);
    }

    let caData: { cert_pem?: string; ca_cert_pem?: string };
    try {
      caData = await caRes.json();
    } catch {
      return c.json({ ok: false, message: 'CA response is not valid JSON' }, 502);
    }

    if (!caData.cert_pem || !caData.ca_cert_pem) {
      return c.json({ ok: false, message: 'CA response missing cert_pem or ca_cert_pem fields' }, 502);
    }

    // 4. Save cert + CA cert (chmod 0600).
    writeFileSync(certPath, caData.cert_pem, { mode: 0o600 });
    writeFileSync(caPath, caData.ca_cert_pem, { mode: 0o600 });

    // Clean up CSR (not needed after enrollment).
    try { unlinkSync(csrPath); } catch { /* best-effort */ }

    // 5. Write $HIVEMIND_HOME/.env with MTLS_* vars.
    const proxyPort = process.env.MTLS_PROXY_PORT ?? '7779';
    const envContent = [
      `# HiveMind mTLS config — written by hivemind setup on ${new Date().toISOString()}`,
      `MTLS_CERT_PATH=${certPath}`,
      `MTLS_KEY_PATH=${keyPath}`,
      `MTLS_CA_PATH=${caPath}`,
      `MTLS_UPSTREAM=https://kernel.silken.ia.br:4443/v1/mcp`,
      `MTLS_PROXY_PORT=${proxyPort}`,
      `HIVEMIND_OWNER=${ownerId}`,
      '',
    ].join('\n');

    const envFile = join(hivemindHome, '.env');
    writeFileSync(envFile, envContent, { mode: 0o600 });

    // 6. Write MCP config for Claude Code.
    //    Try ~/.claude/mcp.json first (Claude Code standard path),
    //    fallback to ~/.mcp.json (older versions / alternative path).
    const mcpConfig = JSON.stringify({
      mcpServers: {
        engram: {
          type: 'http',
          url: `http://127.0.0.1:${proxyPort}/v1/mcp`,
        },
      },
    }, null, 2);

    const claudeDir = join(homedir(), '.claude');
    const claudeMcpPath = join(claudeDir, 'mcp.json');
    const fallbackMcpPath = join(homedir(), '.mcp.json');

    if (existsSync(claudeDir)) {
      writeFileSync(claudeMcpPath, mcpConfig, { mode: 0o644 });
    } else {
      writeFileSync(fallbackMcpPath, mcpConfig, { mode: 0o644 });
    }

    // Mark enrollment done for /setup/status poll.
    enrollmentDone = true;

    return c.json({ ok: true, owner_id: ownerId });

  } catch (err: unknown) {
    // Never expose stack trace to browser.
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[setup/enroll] error:', msg);
    return c.json({ ok: false, message: `Enrollment error: ${msg.slice(0, 300)}` }, 500);
  }
});

// ── GET /setup/status — poll endpoint for CLI ──────────────────────────────────
// The CLI polls this until { done: true } before shutting down the setup server.

setupRouter.get('/status', (c) => {
  return c.json({ done: enrollmentDone });
});
