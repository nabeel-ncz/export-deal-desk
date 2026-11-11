import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { openDb } from './db.ts';
import { seed } from './seed.ts';
import { geminiGenerate } from './llm.ts';
import {
  DEMO_MANDATE, acceptOffer, addMessage, createThread, decideQuote, getThread, inBackground,
  listThreads, loadCatalog, normaliseMandate, runAgentNegotiation, sellerRespond,
} from './threads.ts';
import { limitsFor } from './pricing.ts';
import { paypalClient } from './paypal.ts';
import { closeDeal, handleWebhook, refreshAllOpenPayments, refreshThreadPayments, voidQuote } from './payments.ts';

const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, '..', 'web', 'dist');

const db = await openDb();
const seeded = await seed(db);

const app = Fastify({ logger: true });

// Keep the raw JSON text: PayPal webhook verification needs the body exactly as it was sent.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  (req as { rawBody?: string }).rawBody = body as string;
  try {
    done(null, body ? JSON.parse(body as string) : {});
  } catch {
    done(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
  }
});

app.get('/api/health', async () => {
  const [{ products }] = await db.query<{ products: number }>('SELECT count(*)::int AS products FROM products');
  return {
    ok: true,
    database: db.kind,
    products,
    paypalConfigured: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
  };
});

app.get('/api/seller', async () => {
  const [seller] = await db.query('SELECT * FROM sellers ORDER BY id LIMIT 1');
  const rows = await db.query<{ id: number }>('SELECT * FROM products WHERE seller_id = $1 ORDER BY id', [seller.id]);
  const { policy, products: typed } = await loadCatalog(db);
  // The price the agent can actually go down to: the product floor or the discount cap, whichever is higher.
  const products = rows.map((r) => ({ ...r, lowest_price: limitsFor(policy, typed.find((t) => t.id === r.id)!).minUnitPrice }));
  return { seller, products };
});

// A public demo shares one free-tier AI key, so cap how much work visitors can start.
const MAX_DEALS_PER_HOUR = Number(process.env.MAX_DEALS_PER_HOUR ?? 30);
const MAX_MESSAGES_PER_DEAL = 40;
const recentStarts: number[] = [];
function allowNewDeal() {
  const cutoff = Date.now() - 3_600_000;
  while (recentStarts.length && recentStarts[0] < cutoff) recentStarts.shift();
  if (recentStarts.length >= MAX_DEALS_PER_HOUR) return false;
  recentStarts.push(Date.now());
  return true;
}

const generate = geminiGenerate();
const paypal = paypalClient();
const idOf = (req: { params: unknown }) => Number((req.params as { id: string }).id);
const bodyOf = (req: { body: unknown }) => (req.body ?? {}) as Record<string, any>;

// Business-rule failures (e.g. approving a quote that is not pending) are the caller's error, not a crash.
app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  const status = err.statusCode ?? (/not found/i.test(err.message) ? 404 : 409);
  reply.code(status).send({ error: err.message });
});

app.get('/api/demo-mandate', async () => DEMO_MANDATE);
app.get('/api/threads', async () => listThreads(db));
app.get('/api/threads/:id', async (req) => getThread(db, idOf(req)));

app.post('/api/threads', async (req, reply) => {
  const b = bodyOf(req);
  if (!allowNewDeal()) return reply.code(429).send({ error: 'Demo limit reached: too many deals were started in the last hour. Please try again later.' });
  if (b.mode === 'human') {
    const message = String(b.message ?? '').trim().slice(0, 2000);
    if (!message) return reply.code(400).send({ error: 'message is required' });
    const id = await createThread(db, {
      mode: 'human', buyerName: String(b.buyerName || 'Buyer').slice(0, 80),
      company: b.company ? String(b.company).slice(0, 80) : undefined,
      country: b.country ? String(b.country).slice(0, 80) : undefined,
    });
    await addMessage(db, id, 'buyer', message);
    inBackground(db, id, () => sellerRespond(db, id, generate));
    return { id };
  }
  const mandate = normaliseMandate(b.mandate);
  const id = await createThread(db, { mode: 'agent', buyerName: mandate.contactName, company: mandate.company, country: mandate.country, mandate });
  inBackground(db, id, () => runAgentNegotiation(db, id, generate));
  return { id };
});

app.post('/api/threads/:id/messages', async (req, reply) => {
  const id = idOf(req);
  const message = String(bodyOf(req).content ?? '').trim().slice(0, 2000);
  if (!message) return reply.code(400).send({ error: 'content is required' });
  const { thread, running, messages } = await getThread(db, id);
  if (messages.length >= MAX_MESSAGES_PER_DEAL) return reply.code(409).send({ error: 'This deal has reached the demo message limit. Please start a new one.' });
  if (thread.mode !== 'human') return reply.code(409).send({ error: 'This deal is negotiated by the buyer agent.' });
  if (running) return reply.code(409).send({ error: 'The seller agent is still replying.' });
  await addMessage(db, id, 'buyer', message);
  inBackground(db, id, () => sellerRespond(db, id, generate));
  return { ok: true };
});

app.post('/api/threads/:id/accept', async (req) => ({ quoteId: await acceptOffer(db, idOf(req), 'buyer') }));

// The human seller's decision. No agent can reach this route.
app.post('/api/quotes/:id/decision', async (req, reply) => {
  const decision = bodyOf(req).decision;
  if (decision !== 'approve' && decision !== 'reject') return reply.code(400).send({ error: 'decision must be approve or reject' });
  const quoteId = idOf(req);
  const threadId = await decideQuote(db, quoteId, decision, 'seller');
  // Approval is what unlocks invoicing: only now does the seller agent get the PayPal tool.
  if (decision === 'approve') inBackground(db, threadId, () => closeDeal(db, paypal, generate, quoteId));
  return { ok: true };
});

app.post('/api/quotes/:id/void', async (req) => {
  await voidQuote(db, paypal, idOf(req));
  return { ok: true };
});

app.post('/api/threads/:id/refresh-payment', async (req) => {
  await refreshThreadPayments(db, paypal, idOf(req));
  return { ok: true };
});

app.post('/api/webhooks/paypal', async (req, reply) => {
  const outcome = await handleWebhook(db, paypal, req.headers, (req as { rawBody?: string }).rawBody ?? '');
  return reply.code(outcome === 'rejected' ? 400 : 200).send({ outcome });
});

// In production the built React app is served from the same process.
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Not found' });
  });
}

// Check unpaid invoices with PayPal every 15 seconds, one sweep at a time.
let sweeping = false;
setInterval(() => {
  if (sweeping) return;
  sweeping = true;
  refreshAllOpenPayments(db, paypal).catch(() => undefined).finally(() => { sweeping = false; });
}, 15_000).unref();

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
app.log.info({ database: db.kind, seeded }, 'Export Deal Desk API ready');

// On a public deployment, register the webhook with PayPal so paid invoices are pushed to us.
// Render sets RENDER_EXTERNAL_URL automatically; elsewhere set PUBLIC_URL. The 15-second sweep still runs either way.
const publicUrl = (process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? '').replace(/\/$/, '');
if (publicUrl) {
  paypal.ensureWebhook(`${publicUrl}/api/webhooks/paypal`)
    .then((webhookId) => app.log.info({ webhookId }, 'PayPal webhook registered'))
    .catch((e: Error) => app.log.warn(`PayPal webhook not registered: ${e.message}`));
}
