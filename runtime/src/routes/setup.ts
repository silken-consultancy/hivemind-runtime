// routes/setup.ts — first-login mTLS enrollment popup.
//
// Enrollment is KEY-AS-BOOTSTRAP: a per-user
// api_key is provisioned admin-side BEFORE enrollment; the popup submits it to
// /ca/issue,
// which VALIDATES it and mints an mTLS cert. enrollment_token is RETIRED.
// Contract CONFIRMED against the real enrollment endpoint:
//
//   Request:  POST /ca/issue  body: { csr: string, api_key: string, days?: number }
//   Response: { cert: string, serial: string, token: string, ca_cert_pem: string, tenant: string }
//
// NOTE: /ca/issue does NOT require a client cert — it validates the api_key
// directly (the key IS the identity source: cert CN = the key's tenant). There
// is no client-typed owner_id anymore — the popup only asks for the API Key;
// the real identity (tenant) comes back IN THE RESPONSE, not from anything the
// user types, and the CSR CN is discarded server-side too. Because the tenant
// is only known AFTER /ca/issue responds but the keypair must be generated
// BEFORE that call, the key/cert files are written under a TEMP name first and
// RENAMED to `${tenant}.{key,cert}.pem` once the response lands (see the
// rename block in the handler below). After enrollment, the issued cert is
// used for all subsequent mTLS connections, and the SAME api_key is the x-fos-
// key (Path B) for the MCP.

import { Hono } from 'hono';
import { existsSync, mkdirSync, writeFileSync, chmodSync, unlinkSync, renameSync } from 'node:fs';
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

// Tenant shape: it lands in a filesystem path (the rename target below), so it
// is validated no matter which source it came from — the CA response field or
// the issued cert's CN.
const TENANT_RE = /^[a-zA-Z0-9_-]{1,128}$/;

// certSubjectCN — CN of a PEM certificate, or undefined if it can't be read.
//
// Used ONLY as the fallback identity source when the CA response has no usable
// `tenant` (see resolveTenant below). Reads the cert over STDIN rather than
// from a path so it can run BEFORE the cert is committed to disk — no temp file
// to clean up on the failure path.
//
// openssl (not node:crypto.X509Certificate) because this handler already hard-
// depends on the openssl binary two steps earlier (the keypair/CSR generation),
// so this introduces no new dependency and cannot be the thing that is missing.
// Subject rendering differs across openssl majors — 3.x prints
// `subject=C = BR, CN = x`, 1.x prints `subject= /C=BR/CN=x` — and a subject
// carrying ONLY a CN is rendered `subject=CN = x`, with the label's own `=`
// immediately before the CN. So: strip the `subject=` label FIRST, then match
// the CN on an RDN boundary. Matching the boundary without stripping the label
// silently misses the bare-CN form (caught in review; a multi-RDN fixture had
// hidden it), and matching without any boundary would happily read the `CN` out
// of an unrelated RDN value.
function certSubjectCN(certPem: string): string | undefined {
  const result = Bun.spawnSync(['openssl', 'x509', '-noout', '-subject'], {
    stdin: Buffer.from(certPem),
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (result.exitCode !== 0) return undefined;
  const subject = (result.stdout?.toString() ?? '').trim().replace(/^subject\s*=\s*/i, '');
  const match = subject.match(/(?:^|[,/])\s*CN\s*=\s*([^,/\n]+)/);
  return match?.[1]?.trim();
}

// resolveTenant — the identity of this enrollment, from the CA response's
// `tenant` field, else from the CN of the cert the CA just issued.
//
// DEFENSIVE BY DESIGN (2026-07-31). The `tenant` field used to be a hard
// requirement: absent → HTTP 502 "Resposta da CA não contém um tenant válido",
// and a validly-issued certificate was thrown away. That fired for real when a
// stale server omitted the field, and it was a self-inflicted failure — the CA
// sets the cert's CN to the same tenant, so the identity was sitting in the
// response the whole time, in a second place the client already had in hand.
// Deriving it from the CN decouples the client from that one field permanently;
// enrollment now only fails when BOTH sources are unusable, which is the honest
// condition ("we cannot name this identity"), not a field-presence check.
//
// This does NOT weaken the trust model: the CN is read from the cert the CA
// itself signed and returned, not from anything the client typed — identity is
// still entirely server-resolved (the CSR's own CN is a discarded temp id).
function resolveTenant(responseTenant: string | undefined, certPem: string): string | undefined {
  if (responseTenant && TENANT_RE.test(responseTenant)) return responseTenant;

  const cn = certSubjectCN(certPem);
  if (cn && TENANT_RE.test(cn)) {
    console.warn(
      `[setup/enroll] CA response carried no usable tenant — derived identity from the issued cert CN instead: ${cn}`,
    );
    return cn;
  }
  return undefined;
}

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
    <label for="apikey">API Key</label>
    <input type="password" id="apikey" placeholder="Cole a API Key que você recebeu por e-mail" autocomplete="off">
    <button id="btn" onclick="enroll()">Configurar mTLS</button>
    <div id="log"></div>
  </div>
  <script>
    async function enroll() {
      const apiKey = document.getElementById('apikey').value.trim();
      const log = document.getElementById('log');
      const btn = document.getElementById('btn');
      if (!apiKey) { step('API Key é obrigatória.', 'err'); return; }
      btn.disabled = true;
      log.innerHTML = '';
      step('Enviando pedido de inscrição...', '');
      try {
        const res = await fetch('/setup/enroll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: apiKey })
        });
        const data = await res.json();
        if (data.ok) {
          step('Par de chaves gerado (RSA 2048)', 'ok');
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
//  1. Validate body (api_key required — enrollment_token RETIRED, key-as-bootstrap;
//     no client-typed identity — the tenant comes back IN THE CA RESPONSE)
//  2. Generate RSA keypair + CSR via openssl, written under a TEMP name (Bun.spawnSync;
//     RSA — the CA's forge is RSA-only; TEMP name because the tenant isn't known yet)
//  3. POST /ca/issue { csr, api_key } → { cert, ca_cert_pem, tenant } (api_key resolves
//     tenant server-side)
//  4. Save cert + CA to ~/.engram/mtls/ (chmod 0600), then RENAME key + cert from the
//     TEMP name to `${tenant}.{key,cert}.pem`
//  5. Write $HIVEMIND_HOME/.env with MTLS_* vars + FOS_API_KEY (HIVEMIND_OWNER = tenant)
//  6. Merge-write $HIVEMIND_HOME/.claude/.claude.json (mcpServers.engram, incl.
//     headers['x-fos-key']) — the only path Claude Code actually reads for
//     user-scope MCP discovery (measured, CLI v2.1.207; ~/.claude/mcp.json and
//     ~/.mcp.json are dead paths, never read — item 5.1/F1 fix)
//  7. Return { ok: true, tenant }

setupRouter.post('/enroll', async (c) => {
  let body: { api_key?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, message: 'Corpo JSON inválido' }, 400);
  }

  const { api_key: apiKey } = body;
  if (!apiKey) {
    return c.json({ ok: false, message: 'API Key é obrigatória' }, 400);
  }

  // Validate api_key: length bounds + no newlines (would corrupt env.ts's
  // line-by-line parser, split('\n') + indexOf('=')). Deliberately NOT a
  // CN-safe regex — the real charset of an engram API Key is unknown/wider
  // (may contain base64 chars like +, /, =).
  const trimmedApiKey = apiKey.trim();
  if (trimmedApiKey.length < 8 || trimmedApiKey.length > 512 || /[\n\r]/.test(trimmedApiKey)) {
    return c.json({ ok: false, message: 'A API Key deve ter entre 8 e 512 caracteres e não pode conter quebras de linha' }, 400);
  }

  const hivemindHome = process.env.HIVEMIND_HOME ?? join(homedir(), '.hivemind');
  // See bin/hivemind's CERT_DIR
  // (must stay in sync; this is where the CLI reads the cert from).
  const mtlsDir = join(homedir(), '.engram', 'mtls');

  try {
    // 1. Prepare dirs.
    mkdirSync(hivemindHome, { recursive: true });
    mkdirSync(mtlsDir, { recursive: true });
    chmodSync(mtlsDir, 0o700);

    // TEMP name: the real identity (tenant) is only known once /ca/issue
    // responds (below), but the keypair has to exist before that call — so
    // key/csr/cert are written under this temp id first and the key+cert are
    // RENAMED to `${tenant}.{key,cert}.pem` once the response lands (step 4).
    // The CSR CN below uses this same temp id — it's discarded server-side
    // (cert CN = the api_key's tenant, not the CSR CN), so its value doesn't matter.
    const tempId = crypto.randomUUID();
    const keyPath  = join(mtlsDir, `${tempId}.key.pem`);
    const csrPath  = join(mtlsDir, `${tempId}.csr.pem`);
    const tempCertPath = join(mtlsDir, `${tempId}.cert.pem`);
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
      '-subj', `/CN=${tempId}`,
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
      // No client cert here — /ca/issue validates the pre-provisioned api_key
      // (key-as-bootstrap). Body shape per the enrollment
      // contract: { csr, api_key }. The api_key RESOLVES the tenant
      // server-side (cert CN = the key's tenant) — enrollment_token is RETIRED,
      // no client-asserted tenant.
      caRes = await fetch(caUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csr: csrPem, api_key: apiKey }),
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
    // ca_cert_pem, tenant } — NOT { cert_pem, ca_cert_pem } (that shape never
    // existed on the server; this is the contract fix). `tenant` is the ONLY
    // source of identity now — it's what the api_key resolved to server-side,
    // not anything the client typed or asserted.
    let caData: { cert?: string; serial?: string; token?: string; ca_cert_pem?: string; tenant?: string };
    try {
      caData = (await caRes.json()) as typeof caData;
    } catch {
      return c.json({ ok: false, message: 'Resposta da CA não é um JSON válido' }, 502);
    }

    if (!caData.cert || !caData.ca_cert_pem) {
      return c.json({ ok: false, message: 'Resposta da CA não contém os campos cert ou ca_cert_pem' }, 502);
    }
    // Identity: the response's `tenant`, falling back to the CN of the cert the
    // CA just issued (resolveTenant, above — both sources shape-checked, since
    // the value lands in a filesystem path just below). Only a failure of BOTH
    // is fatal; a missing `tenant` field alone no longer discards a valid cert.
    const tenant = resolveTenant(caData.tenant, caData.cert);
    if (!tenant) {
      return c.json({
        ok: false,
        message: 'Resposta da CA não contém um tenant válido, e não foi possível derivar a identidade do CN do certificado emitido',
      }, 502);
    }
    const keyFinalPath  = join(mtlsDir, `${tenant}.key.pem`);
    const certFinalPath = join(mtlsDir, `${tenant}.cert.pem`);

    // 4. Save cert (under the temp name) + CA cert (chmod 0600), then RENAME
    // key + cert from the temp id to the real tenant-based name now that the
    // tenant is known (see the TEMP-name comment at step 2 above).
    writeFileSync(tempCertPath, caData.cert, { mode: 0o600 });
    writeFileSync(caPath, caData.ca_cert_pem, { mode: 0o600 });
    renameSync(keyPath, keyFinalPath);
    renameSync(tempCertPath, certFinalPath);

    // Clean up CSR (not needed after enrollment).
    try { unlinkSync(csrPath); } catch { /* best-effort */ }

    // 5. Write $HIVEMIND_HOME/.env with MTLS_* vars + FOS_API_KEY (item 6.1,
    // auth cert+chave). FOS_API_KEY is consumed by the DAEMON now (atomic-
    // flip, round-2 2026-07-30): mtls-proxy.ts injects x-fos-key server-side
    // on the outbound hop from this same .env var (exported into the
    // daemon's env by bin/hivemind's `set -a; . .env; set +a`) — Claude
    // Code's own MCP config (step 6 below) no longer carries the key at all.
    const proxyPort = process.env.MTLS_PROXY_PORT ?? '7779';
    const envContent = [
      `# HiveMind mTLS config — written by hivemind setup on ${new Date().toISOString()}`,
      `MTLS_CERT_PATH=${certFinalPath}`,
      `MTLS_KEY_PATH=${keyFinalPath}`,
      `MTLS_CA_PATH=${caPath}`,
      `MTLS_UPSTREAM=https://${ENDPOINT}/v1/mcp`,
      `MTLS_PROXY_PORT=${proxyPort}`,
      `HIVEMIND_ENDPOINT=${ENDPOINT}`,
      `HIVEMIND_OWNER=${tenant}`,
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
    // mcpServers.engram (atomic-flip, round-2 2026-07-30 — supersedes the
    // item 6.1 headers['x-fos-key'] template + its OPEN-cfg-A live-expansion
    // proof, both removed here): url is now https://127.0.0.1:<port>/v1/mcp, matching the
    // local HTTPS-only listener (mtls-proxy.ts item 1.1(B)) — validates
    // against the local CA trusted into the system store by item 1.4, so no
    // manual "accept this certificate" prompt. NO headers written: the proxy
    // injects x-fos-key server-side from FOS_API_KEY in .env (mtls-proxy.ts
    // item 1.1(A)), so this file — readable by anything with fs access to
    // $HIVEMIND_HOME — carries zero secret material regardless of what wrote
    // or read it.
    const mergedConfig = {
      ...existingConfig,
      mcpServers: {
        ...(existingConfig.mcpServers as Record<string, unknown> | undefined),
        engram: {
          type: 'http',
          url: `https://127.0.0.1:${proxyPort}/v1/mcp`,
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

    return c.json({ ok: true, tenant });

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
