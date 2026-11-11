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
  listThreads, normaliseMandate, runAgentNegotiation, sellerRespond,
} from './threads.ts';

const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, '..', 'web', 'dist');

const db = await openDb();
const seeded = await seed(db);

const app = Fastify({ logger: true });

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
  const products = await db.query('SELECT * FROM products WHERE seller_id = $1 ORDER BY id', [seller.id]);
  return { seller, products };
});

const generate = geminiGenerate();
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
  const { thread, running } = await getThread(db, id);
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
  await decideQuote(db, idOf(req), decision, 'seller');
  return { ok: true };
});

// In production the built React app is served from the same process.
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Not found' });
  });
}

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
app.log.info({ database: db.kind, seeded }, 'Export Deal Desk API ready');
