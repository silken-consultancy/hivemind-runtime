// GET /healthz — uptime + version. Public, no auth required.

import { Hono } from 'hono';
import { VERSION } from '../version.ts';

export const health = new Hono();

const startTime = Date.now();

health.get('/', (c) => {
  return c.json({
    status: 'ok',
    version: VERSION,
    uptime_s: Math.floor((Date.now() - startTime) / 1000),
  });
});
