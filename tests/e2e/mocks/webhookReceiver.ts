import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { verifySignature } from '../../../src/server/publish/webhookSignature';
import { WEBHOOK_PORT, WEBHOOK_SECRET } from '../support/env';

// Downstream webhook receiver (E2E only). Verifies X-Signature (HMAC-SHA256 over the exact raw body, task 31) and
// records every delivery so specs can assert the payload and the signature. Control API under /__mock.

interface Delivery {
  signature: string | null;
  signatureValid: boolean;
  deliveryId: string | null;
  body: unknown;
}

let deliveries: Delivery[] = [];

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', `http://localhost:${WEBHOOK_PORT}`).pathname;
  const raw = await readBody(req);

  if (path === '/__mock/health') return send(res, 200, { ok: true });
  if (path === '/__mock/state') return send(res, 200, { deliveries });
  if (path === '/__mock/reset' && req.method === 'POST') {
    deliveries = [];
    return send(res, 200, { ok: true });
  }

  if (path === '/hook' && req.method === 'POST') {
    const header = req.headers['x-signature'];
    const signature = typeof header === 'string' ? header : null;
    const signatureValid = signature !== null && verifySignature(raw, WEBHOOK_SECRET, signature);
    let body: unknown = null;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      // Recorded as null; the spec fails on it.
    }
    const deliveryId = req.headers['x-delivery-id'];
    deliveries.push({ signature, signatureValid, deliveryId: typeof deliveryId === 'string' ? deliveryId : null, body });
    return send(res, signatureValid ? 200 : 401, { ok: signatureValid });
  }
  return send(res, 404, { error: 'not found' });
}

createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error('[webhook-receiver] handler error', err);
    if (!res.headersSent) send(res, 500, { error: 'receiver error' });
  });
}).listen(WEBHOOK_PORT, () => {
  console.log(`[webhook-receiver] listening on ${WEBHOOK_PORT}`);
});
