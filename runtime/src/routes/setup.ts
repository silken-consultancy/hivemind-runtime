// routes/setup.ts — first-login mTLS enrollment popup.
//
// Companion to bin/fos-beta-enroll (B2, cross-repo — 4tuenyOS) which mints the
// enrollment token server-side. Token contract (against POST /ca/issue on the
// product endpoint, HIVEMIND_ENDPOINT — default hivemind.silken.ia.br:4443) —
// contract CONFIRMED against the real ca.controller.ts (ENROLLMENT branch,
// engram/apps/auth-service/src/ca/ca.controller.ts):
//
//   Request:  POST /ca/issue  body: { tenant: string, enrollment_token: string, csr: string, days?: number }
//   Response: { cert: string, serial: string, token: string, ca_cert_pem: string }
//
// NOTE: /ca/issue does NOT require a client cert — it validates the enrollment
// token directly (token is the authorization mechanism at enrollment time).
// After enrollment, the issued cert is used for all subsequent mTLS connections.

import { Hono } from 'hono';
import { existsSync, mkdirSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Product endpoint — parametrized (P0 fix). Set via HIVEMIND_ENDPOINT env
// (written by install.sh --endpoint; preserved across enrollment).
const ENDPOINT = process.env.HIVEMIND_ENDPOINT ?? 'hivemind.silken.ia.br:4443';

// Enrollment (/ca/issue) goes over the public 443/Let's-Encrypt surface (Caddy →
// auth-service), NOT the :4443 MCP mTLS port. Two reasons :4443 fails for enrollment:
// (a) it's mutual-mTLS (requestCert) but the client has no cert yet at enrollment —
// it's bootstrapping to GET one — so the server closes the socket; (b) even certless,
// the :4443 server cert is signed by the product CA which the client doesn't have yet
// → "self signed certificate in certificate chain". The 443/LE surface is certless AND
// publicly trusted, so the bootstrap works without the product CA; the issued
// ca_cert_pem is then pinned for the :4443 mTLS proxy. NOTE: cert RENEWAL is mutual-mTLS
// and won't traverse Caddy/443 (client cert terminated there) — renewal needs a direct
// :4443 path (future design; does not block initial enrollment).
const ENROLL_HOST = ENDPOINT.split(':')[0];

export const setupRouter = new Hono();

// In-memory flag: true once enrollment completes in this server lifetime.
// Used by GET /setup/status for the CLI to poll.
let enrollmentDone = false;

// ── GET /setup — HTML enrollment form ─────────────────────────────────────────

setupRouter.get('/', (c) => {
  const html = `<!DOCTYPE html>
<html lang="pt-br">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HiveMind — Configuração inicial</title>
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
    <p class="sub">Configure seu certificado pessoal para conectar à memória.</p>
    <label for="token">Token de Inscrição</label>
    <input type="password" id="token" placeholder="Cole o token enviado pelo seu admin" autocomplete="off">
    <label for="owner">ID do Usuário</label>
    <input type="text" id="owner" placeholder="ex: beta-joao" autocomplete="off">
    <label for="apikey">API Key</label>
    <input type="password" id="apikey" placeholder="Cole a API Key de config→api_key" autocomplete="off">
    <button id="btn" onclick="enroll()">Configurar mTLS</button>
    <div id="log"></div>
  </div>
  <script>
    async function enroll() {
      const token = document.getElementById('token').value.trim();
      const owner = document.getElementById('owner').value.trim();
      const apiKey = document.getElementById('apikey').value.trim();
      const log = document.getElementById('log');
      const btn = document.getElementById('btn');
      if (!token || !owner || !apiKey) { step('Token, ID do Usuário e API Key são obrigatórios.', 'err'); return; }
      btn.disabled = true;
      log.innerHTML = '';
      step('Enviando pedido de inscrição...', '');
      try {
        const res = await fetch('/setup/enroll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, owner_id: owner, api_key: apiKey })
        });
        const data = await res.json();
        if (data.ok) {
          step('Par de chaves gerado (EC P-256)', 'ok');
          step('CSR enviado para a CA', 'ok');
          step('Certificado recebido e salvo', 'ok');
          step('Configuração do proxy gravada', 'ok');
          log.innerHTML += '<div class="go">GO — Certificado configurado.<br>Feche esta aba e rode <code>hivemind</code> no diretório do seu projeto.</div>';
        } else {
          step('Erro: ' + (data.message || 'erro desconhecido'), 'err');
          log.innerHTML += '<div class="nogo">NO-GO — ' + escHtml(data.message || 'Falha na inscrição.') + '</div>';
          btn.disabled = false;
        }
      } catch (err) {
        step('Erro de rede: ' + err.message, 'err');
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
//  1. Validate body (token + owner_id + api_key required)
//  2. Generate RSA keypair + CSR via openssl (Bun.spawnSync; RSA — the CA's forge is RSA-only)
//  3. POST /ca/issue → { cert, ca_cert_pem }
//  4. Save key + cert + CA to ~/.engram/mtls/ (chmod 0600)
//  5. Write $HIVEMIND_HOME/.env with MTLS_* vars + FOS_API_KEY
//  6. Merge-write $HIVEMIND_HOME/.claude/.claude.json (mcpServers.engram, incl.
//     headers['x-fos-key']) — the only path Claude Code actually reads for
//     user-scope MCP discovery (measured, CLI v2.1.207; ~/.claude/mcp.json and
//     ~/.mcp.json are dead paths, never read — item 5.1/F1 fix)
//  7. Return { ok: true, owner_id }

setupRouter.post('/enroll', async (c) => {
  let body: { token?: string; owner_id?: string; api_key?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, message: 'Corpo JSON inválido' }, 400);
  }

  const { token, owner_id: ownerId, api_key: apiKey } = body;
  if (!token || !ownerId || !apiKey) {
    return c.json({ ok: false, message: 'Token, ID do usuário e API Key são obrigatórios' }, 400);
  }

  // Sanitize owner_id: only alphanumeric, dash, underscore (CN-safe).
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(ownerId)) {
    return c.json({ ok: false, message: 'O ID do usuário deve conter apenas letras, números, hífen ou underscore (máx. 64 caracteres)' }, 400);
  }

  // Validate api_key: length bounds + no newlines (would corrupt env.ts's
  // line-by-line parser, split('\n') + indexOf('=')). Deliberately NOT the
  // CN-safe regex used for owner_id above — the real charset of an engram API
  // Key is unknown/wider (may contain base64 chars like +, /, =).
  const trimmedApiKey = apiKey.trim();
  if (trimmedApiKey.length < 8 || trimmedApiKey.length > 512 || /[\n\r]/.test(trimmedApiKey)) {
    return c.json({ ok: false, message: 'A API Key deve ter entre 8 e 512 caracteres e não pode conter quebras de linha' }, 400);
  }

  const hivemindHome = process.env.HIVEMIND_HOME ?? join(homedir(), '.hivemind');
  // Isolated from the lab's own ~/.fos/mtls — see bin/hivemind's CERT_DIR
  // (must stay in sync; this is where the CLI reads the cert from).
  const mtlsDir = join(homedir(), '.engram', 'mtls');

  try {
    // 1. Prepare dirs.
    mkdirSync(hivemindHome, { recursive: true });
    mkdirSync(mtlsDir, { recursive: true });
    chmodSync(mtlsDir, 0o700);

    const keyPath  = join(mtlsDir, `${ownerId}.key.pem`);
    const csrPath  = join(mtlsDir, `${ownerId}.csr.pem`);
    const certPath = join(mtlsDir, `${ownerId}.cert.pem`);
    const caPath   = join(mtlsDir, 'ca.cert.pem');

    // 2. Generate RSA keypair + CSR via openssl. RSA (not EC) because the CA
    // signs with node-forge, whose CSR parser only supports RSA public keys — an
    // EC P-256 CSR fails on the server with "Cannot read public key. OID is not
    // RSA" → 400 invalid_csr (measured against node-forge 1.4.0; found by INT-1
    // dogfood). If the CA ever moves to an EC-capable lib, revisit this.
    const opensslResult = Bun.spawnSync([
      'openssl', 'req',
      '-newkey', 'rsa:2048',
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
      return c.json({ ok: false, message: 'Arquivo CSR vazio após o openssl — verifique a instalação do openssl' }, 500);
    }

    const caUrl = `https://${ENROLL_HOST}/ca/issue`;
    let caRes: Response;
    try {
      // No client cert here — /ca/issue validates via enrollment token.
      // Body shape matches the real server contract (issueBodySchema in
      // ca.controller.ts): { tenant, enrollment_token, csr }, NOT { token, csr_pem }.
      caRes = await fetch(caUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant: ownerId, enrollment_token: token, csr: csrPem }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (fetchErr: unknown) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      return c.json({ ok: false, message: `Não foi possível conectar à CA em ${caUrl}: ${msg}` }, 502);
    }

    if (!caRes.ok) {
      const errBody = await caRes.text().catch(() => '');
      return c.json({
        ok: false,
        message: `CA retornou HTTP ${caRes.status}: ${errBody.slice(0, 300)}`,
      }, 502);
    }

    // Response shape matches the real server contract: { cert, serial, token,
    // ca_cert_pem } — NOT { cert_pem, ca_cert_pem } (that shape never existed
    // on the server; this is the contract fix).
    let caData: { cert?: string; serial?: string; token?: string; ca_cert_pem?: string };
    try {
      caData = await caRes.json();
    } catch {
      return c.json({ ok: false, message: 'Resposta da CA não é um JSON válido' }, 502);
    }

    if (!caData.cert || !caData.ca_cert_pem) {
      return c.json({ ok: false, message: 'Resposta da CA não contém os campos cert ou ca_cert_pem' }, 502);
    }

    // 4. Save cert + CA cert (chmod 0600).
    writeFileSync(certPath, caData.cert, { mode: 0o600 });
    writeFileSync(caPath, caData.ca_cert_pem, { mode: 0o600 });

    // Clean up CSR (not needed after enrollment).
    try { unlinkSync(csrPath); } catch { /* best-effort */ }

    // 5. Write $HIVEMIND_HOME/.env with MTLS_* vars + FOS_API_KEY (item 6.1,
    // auth cert+chave — consumed by bin/hivemind's `set -a; . .env; set +a`,
    // which exports it into the `exec env ... claude` environment so the
    // MCP entry's `headers['x-fos-key']: '${FOS_API_KEY}'` can resolve it).
    const proxyPort = process.env.MTLS_PROXY_PORT ?? '7779';
    const envContent = [
      `# HiveMind mTLS config — written by hivemind setup on ${new Date().toISOString()}`,
      `MTLS_CERT_PATH=${certPath}`,
      `MTLS_KEY_PATH=${keyPath}`,
      `MTLS_CA_PATH=${caPath}`,
      `MTLS_UPSTREAM=https://${ENDPOINT}/v1/mcp`,
      `MTLS_PROXY_PORT=${proxyPort}`,
      `HIVEMIND_ENDPOINT=${ENDPOINT}`,
      `HIVEMIND_OWNER=${ownerId}`,
      `FOS_API_KEY=${trimmedApiKey}`,
      '',
    ].join('\n');

    const envFile = join(hivemindHome, '.env');
    writeFileSync(envFile, envContent, { mode: 0o600 });

    // 6. Merge-write $HIVEMIND_HOME/.claude/.claude.json — the only path
    // Claude Code v2.1.207 actually reads for user-scope MCP server discovery
    // (measured; ~/.claude/mcp.json and ~/.mcp.json below are DEAD paths,
    // never read by this CLI version — this is the item 5.1/F1 contract fix).
    // MERGE-SAFE: read→parse (try/catch, corrupted/absent → {}) →spread→
    // overwrite only mcpServers.engram, so any OTHER top-level key or other
    // mcpServers.* entry that already exists survives (P1 pitfall — tested:
    // running enrollment twice, and against a pre-existing .claude.json with
    // an arbitrary extra key + another mcpServers.* entry, both survive).
    const claudeConfigPath = join(hivemindHome, '.claude', '.claude.json');
    let existingConfig: Record<string, unknown> = {};
    if (existsSync(claudeConfigPath)) {
      try {
        const parsed: unknown = JSON.parse(await Bun.file(claudeConfigPath).text());
        // Guard (code-review hardening): a syntactically-valid JSON document
        // that isn't a plain object — top-level `null`, a number, a string, or
        // an array — must ALSO fall back to {}, not just a parse failure. The
        // parse itself would succeed for e.g. `null`, and `existingConfig`
        // would be typed as `Record<string, unknown>` at compile time but
        // actually hold `null`/an array at runtime — `existingConfig.mcpServers`
        // below would then throw (`null.mcpServers`) instead of self-healing,
        // turning a corrupted file into a 500 instead of the declared contract
        // ("corrompido → {}, nunca aborta o enrollment").
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          existingConfig = {};
        } else {
          existingConfig = parsed as Record<string, unknown>;
        }
      } catch {
        existingConfig = {};
      }
    }
    // headers['x-fos-key'] (item 6.1, auth cert+chave): the literal string
    // '${FOS_API_KEY}' is written here, relying on the Claude Code CLI's http
    // transport expanding ${VAR} from the process env at connect time (the
    // same env bin/hivemind already exports via `set -a; . .env; set +a`
    // before `exec env ... claude`). OPEN-cfg-A RESOLVED LIVE this pass (CLI
    // v2.1.207, matching the version pin): a probe MCP http server + a
    // `.claude.json` with `headers: {"x-test-var": "${TESTVAR}"}` under an
    // isolated CLAUDE_CONFIG_DIR showed the literal value `${TESTVAR}` DOES
    // get expanded from the process env — the upstream request arrived with
    // the header already substituted, not the template string. G-cfg1 (real
    // enrollment against the real engram MCP endpoint) is still the
    // end-to-end confirmation, but the CLI-level expansion mechanism itself is
    // no longer an open question. Fallback (literal trimmedApiKey value
    // instead of the template) is therefore NOT expected to be needed, but is
    // documented here in case G-cfg1 surfaces an unrelated 401.
    const mergedConfig = {
      ...existingConfig,
      mcpServers: {
        ...(existingConfig.mcpServers as Record<string, unknown> | undefined),
        engram: {
          type: 'http',
          url: `http://127.0.0.1:${proxyPort}/v1/mcp`,
          headers: { 'x-fos-key': '${FOS_API_KEY}' },
        },
      },
    };
    mkdirSync(join(hivemindHome, '.claude'), { recursive: true });
    // mode 0600 (not 0644): the merge preserves pre-existing Claude Code keys
    // (e.g. oauthAccount) and rewrites the whole file — don't widen the
    // permissions of that account metadata. The URL itself is localhost (no
    // secret), but matching the 600 posture already used for .env/.credentials
    // is the correct default for a file that may carry other people's secrets.
    writeFileSync(claudeConfigPath, JSON.stringify(mergedConfig, null, 2), { mode: 0o600 });

    // Mark enrollment done for /setup/status poll.
    enrollmentDone = true;

    return c.json({ ok: true, owner_id: ownerId });

  } catch (err: unknown) {
    // Never expose stack trace to browser.
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[setup/enroll] error:', msg);
    return c.json({ ok: false, message: `Erro na inscrição: ${msg.slice(0, 300)}` }, 500);
  }
});

// ── GET /setup/status — poll endpoint for CLI ──────────────────────────────────
// The CLI polls this until { done: true } before shutting down the setup server.

setupRouter.get('/status', (c) => {
  return c.json({ done: enrollmentDone });
});
