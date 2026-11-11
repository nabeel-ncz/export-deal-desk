import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { openDb } from './db.ts';
import { seed } from './seed.ts';

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
