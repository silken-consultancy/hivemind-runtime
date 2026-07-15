// Environment configuration for hivemind-runtime.
// Loads from $HIVEMIND_HOME/.env before zod parse — makes the service self-sufficient
// when started directly (bun src/server.ts) rather than via the bash wrapper.
//
// KEY CHANGE vs fos-agent-runtime: default home is HIVEMIND_HOME ($HOME/.hivemind),
// NOT FOS_ROOT (/home/desktop/projetos/4tuenyOS). FOS_ROOT kept as fallback only.

import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function loadHivemindEnv() {
  const hivemindHome = process.env.HIVEMIND_HOME
    ?? process.env.FOS_ROOT  // fallback de compatibilidade — não expandido aqui
    ?? join(homedir(), '.hivemind');
  const envFile = join(hivemindHome, '.env');
  if (!existsSync(envFile)) return;
  const lines = readFileSync(envFile, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip surrounding quotes (single or double).
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Only set if not already in environment (shell export takes precedence).
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadHivemindEnv();

const schema = z.object({
  // ── Server binding ────────────────────────────────────────────────────────
  AR_BIND: z.string().default('127.0.0.1'),
  AR_PORT: z.coerce.number().int().positive().default(7777),
  AR_API_TOKEN: z.string().optional(),

  // ── mTLS proxy (loopback → engram :4443) ─────────────────────────────────
  // MTLS_PROXY_PORT absent = proxy disabled (feature opt-in).
  // MTLS_PROXY_PORT set without the 3 cert paths = proxy disabled + log warning.
  MTLS_PROXY_PORT: z.coerce.number().int().positive().optional(),
  // Product endpoint (host:port). Single source of truth; MTLS_UPSTREAM derives from it.
  HIVEMIND_ENDPOINT: z.string().default('hivemind.silken.ia.br:4443'),
  MTLS_UPSTREAM: z.string().url().optional(),
  MTLS_CERT_PATH: z.string().optional(),
  MTLS_KEY_PATH: z.string().optional(),
  MTLS_CA_PATH: z.string().optional(),

  // Durable per-machine identity (bin/hivemind:_resolve_device_id, Fase 6,
  // DR-6.3) — exported into the daemon's env by _spawn_runtime so reconcile
  // (Fase 2) and lifecycle events (Fase 4) tag their own device without a
  // second, divergent notion of "device" inside this process. Optional: a
  // daemon started directly (`bun src/server.ts`, bypassing the bash
  // wrapper) simply runs without it rather than failing to boot.
  HIVEMIND_DEVICE_ID: z.string().optional(),

  // Bearer for backend MCP calls over the direct mTLS upstream (Fase 2,
  // DR-2.2, docs/wip/hivemind-runtime-lifecycle-daemon-reconcile-port.md) —
  // heartbeat/pause/resume/list_active (backend-mcp-client.ts) all send this
  // as the x-fos-key header. Written into $HIVEMIND_HOME/.env by setup.ts
  // (enrollment) and exported into the daemon's environment by bin/hivemind's
  // `set -a; . .env; set +a` — the same key the CLI's own `exec env` MCP
  // entry resolves. Optional for the same reason HIVEMIND_DEVICE_ID is: a
  // daemon started before enrollment (or directly, bypassing the wrapper)
  // simply has nothing to call the backend with — backend-mcp-client.ts
  // degrades every call to a no-op rather than failing to boot.
  FOS_API_KEY: z.string().optional(),

  HOME: z.string().default('/root'),
});

type EnvConfig = z.infer<typeof schema>;

function loadEnv(): EnvConfig {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error('[env] Invalid environment configuration:');
    console.error(parsed.error.format());
    process.exit(1);
  }
  const cfg = parsed.data;

  // Derive MTLS_UPSTREAM from HIVEMIND_ENDPOINT unless explicitly overridden.
  if (!cfg.MTLS_UPSTREAM) {
    cfg.MTLS_UPSTREAM = `https://${cfg.HIVEMIND_ENDPOINT}/v1/mcp`;
  }

  // Guard: proxy and main server must not share a port.
  if (cfg.MTLS_PROXY_PORT !== undefined && cfg.MTLS_PROXY_PORT === cfg.AR_PORT) {
    console.error(
      `[env] FATAL: MTLS_PROXY_PORT (${cfg.MTLS_PROXY_PORT}) e AR_PORT (${cfg.AR_PORT}) conflitam. ` +
      'Defina MTLS_PROXY_PORT em uma porta diferente de AR_PORT.',
    );
    process.exit(1);
  }

  return cfg;
}

export const env = loadEnv();

// ─── mtlsProxyConfig ──────────────────────────────────────────────────────────
// Returns mTLS proxy config if all MTLS_* vars are present, null otherwise.
// Paths with leading `~` are expanded to homedir().

function expandPath(p: string): string {
  // Use slice(1) not replace('~', ...) to avoid substituting ~ mid-path.
  return p.startsWith('~') ? homedir() + p.slice(1) : p;
}

export function mtlsProxyConfig(): {
  port: number;
  upstream: string;
  certPath: string;
  keyPath: string;
  caPath: string;
} | null {
  const port = env.MTLS_PROXY_PORT;
  if (!port) return null;

  // MTLS_UPSTREAM is derived from HIVEMIND_ENDPOINT in loadEnv — defined here.
  const upstream = env.MTLS_UPSTREAM;
  const certPath = env.MTLS_CERT_PATH;
  const keyPath  = env.MTLS_KEY_PATH;
  const caPath   = env.MTLS_CA_PATH;

  if (!certPath || !keyPath || !caPath) {
    console.error(
      '[mtls-proxy] NOT STARTED: MTLS_PROXY_PORT set but MTLS_CERT_PATH/KEY_PATH/CA_PATH absent. ' +
      'Define all 3 or remove MTLS_PROXY_PORT.',
    );
    return null;
  }

  return {
    port,
    upstream: upstream!,
    certPath: expandPath(certPath),
    keyPath:  expandPath(keyPath),
    caPath:   expandPath(caPath),
  };
}

// ─── mtlsCredentials ──────────────────────────────────────────────────────────
// Cert/key/ca + upstream for DIRECT daemon→backend calls (backend-mcp-client.ts,
// Fase 2) — deliberately NOT gated on MTLS_PROXY_PORT the way mtlsProxyConfig()
// is. MTLS_PROXY_PORT is a precondition for the LOCAL PROXY LISTENER only; it
// says nothing about whether this process can itself reach the backend over
// mTLS. Fase-2 review (docs/wip/hivemind-runtime-lifecycle-daemon-reconcile-port.md)
// measured live that reusing mtlsProxyConfig() here silently no-op'd every
// daemon→backend call (heartbeat/reconcile/pause/resume) whenever
// MTLS_PROXY_PORT was unset, even with a perfectly valid cert/key/ca/upstream
// — the exact proxy-health coupling backend-mcp-client.ts's own header comment
// says must not happen. Enrollment (setup.ts) always writes
// MTLS_CERT_PATH/KEY_PATH/CA_PATH/MTLS_UPSTREAM together, so cert presence
// alone is the correct, independent precondition for this path.
export function mtlsCredentials(): {
  upstream: string;
  certPath: string;
  keyPath: string;
  caPath: string;
} | null {
  const certPath = env.MTLS_CERT_PATH;
  const keyPath  = env.MTLS_KEY_PATH;
  const caPath   = env.MTLS_CA_PATH;
  if (!certPath || !keyPath || !caPath) return null;

  return {
    // MTLS_UPSTREAM is derived from HIVEMIND_ENDPOINT in loadEnv — always defined.
    upstream: env.MTLS_UPSTREAM!,
    certPath: expandPath(certPath),
    keyPath:  expandPath(keyPath),
    caPath:   expandPath(caPath),
  };
}
