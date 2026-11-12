import type { Db } from './db.ts';
import type { Generate } from './llm.ts';
import { buyerTurn, sellerTurn, type Offer, type SellerProfile, type TraceEntry, type Turn } from './agents.ts';
import { splitDeposit, type BuyerMandate, type Product, type QuoteNumbers, type SellerPolicy } from './pricing.ts';

/** Deal threads: persistence plus the only code paths that change a quote's status. */

type Row = Record<string, any>;

export const DEMO_MANDATE: BuyerMandate = {
  company: 'Harbor & Pine Home', country: 'United States', contactName: 'Dana Whitfield',
  need: 'Handwoven seagrass storage baskets (SKU MW-BSK-01) for our retail stores',
  quantity: 150, targetUnitPrice: 13.6, maxUnitPrice: 15.4, maxDeliveryDays: 30, incoterm: 'FOB',
  mustHaves: ['Private-label hang tags'],
};

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

export function normaliseMandate(input: Row | undefined): BuyerMandate {
  const d = DEMO_MANDATE;
  const maxUnitPrice = Math.round(clamp(input?.maxUnitPrice, 0.01, 10_000, d.maxUnitPrice) * 100) / 100;
  return {
    ...d,
    quantity: Math.round(clamp(input?.quantity, 1, 100_000, d.quantity)),
    maxUnitPrice,
    targetUnitPrice: Math.min(maxUnitPrice, Math.round(clamp(input?.targetUnitPrice, 0.01, 10_000, d.targetUnitPrice) * 100) / 100),
    maxDeliveryDays: Math.round(clamp(input?.maxDeliveryDays, 1, 365, d.maxDeliveryDays)),
  };
}

export async function loadCatalog(db: Db): Promise<{ sellerId: number; seller: SellerProfile; policy: SellerPolicy; products: Product[] }> {
  const [s] = await db.query<Row>('SELECT * FROM sellers ORDER BY id LIMIT 1');
  const rows = await db.query<Row>('SELECT * FROM products WHERE seller_id = $1 ORDER BY id', [s.id]);
  return {
    sellerId: s.id,
    seller: { name: s.name, city: s.city, country: s.country },
    policy: { maxDiscountPct: Number(s.max_discount_pct), depositPct: Number(s.deposit_pct), acceptedIncoterms: s.accepted_incoterms },
    products: rows.map((r) => ({
      id: r.id, sku: r.sku, name: r.name, description: r.description,
      unitCost: Number(r.unit_cost), listPrice: Number(r.list_price), minPrice: Number(r.min_price),
      moq: r.moq, capacityUnits: r.capacity_units, leadTimeDays: r.lead_time_days,
    })),
  };
}

const QUOTE_SQL = `
  SELECT q.*, i.quantity, i.unit_price, p.sku, p.name AS product_name
  FROM quote_drafts q JOIN quote_items i ON i.quote_id = q.id JOIN products p ON p.id = i.product_id`;

export function toOffer(r: Row): Offer {
  const total = Number(r.total), depositPct = Number(r.deposit_pct);
  return {
    version: r.version, sku: r.sku, productName: r.product_name,
    quantity: r.quantity, unitPrice: Number(r.unit_price), incoterm: r.incoterm, deliveryDays: r.delivery_days,
    subtotal: Number(r.subtotal), discountPct: Number(r.discount_pct), total, marginPct: Number(r.margin_pct),
    depositPct, ...splitDeposit(total, depositPct),
  };
}

async function liveQuote(db: Db, threadId: number): Promise<Row | null> {
  const [r] = await db.query<Row>(
    `${QUOTE_SQL} WHERE q.thread_id = $1 AND q.status IN ('draft', 'pending_approval', 'approved') ORDER BY q.version DESC LIMIT 1`, [threadId]);
  return r ?? null;
}

export async function quoteWithItem(db: Db, quoteId: number): Promise<Row> {
  const [r] = await db.query<Row>(`${QUOTE_SQL} WHERE q.id = $1`, [quoteId]);
  if (!r) throw new Error(`Quote ${quoteId} not found`);
  return r;
}

export async function audit(db: Db, threadId: number | null, actor: string, action: string, detail: unknown = {}) {
  await db.query('INSERT INTO audit_logs (thread_id, actor, action, detail) VALUES ($1, $2, $3, $4::text::jsonb)',
    [threadId, actor, action, JSON.stringify(detail)]);
}

export async function addMessage(db: Db, threadId: number, role: string, content: string, toolTrace: unknown = null) {
  await db.query('INSERT INTO messages (thread_id, role, content, tool_trace) VALUES ($1, $2, $3, $4::text::jsonb)',
    [threadId, role, content, toolTrace === null ? null : JSON.stringify(toolTrace)]);
}

export async function createThread(db: Db, t: { mode: 'human' | 'agent'; buyerName: string; company?: string; country?: string; mandate?: BuyerMandate }) {
  const { sellerId } = await loadCatalog(db);
  const [row] = await db.query<{ id: number }>(
    `INSERT INTO buyer_threads (seller_id, buyer_name, buyer_company, buyer_country, mode, buyer_mandate)
     VALUES ($1, $2, $3, $4, $5, $6::text::jsonb) RETURNING id`,
    [sellerId, t.buyerName, t.company ?? null, t.country ?? null, t.mode, t.mandate ? JSON.stringify(t.mandate) : null]);
  await audit(db, row.id, t.mode === 'agent' ? 'buyer_agent' : 'buyer', 'thread_opened', { mode: t.mode });
  return row.id;
}

export async function transcriptOf(db: Db, threadId: number): Promise<Turn[]> {
  const rows = await db.query<Row>(`SELECT role, content, tool_trace FROM messages WHERE thread_id = $1 AND role <> 'system' ORDER BY id`, [threadId]);
  return rows.map((m) => ({ role: m.role.startsWith('buyer') ? 'buyer' : 'seller', text: m.content, offer: m.tool_trace?.offer ?? null }));
}

async function threadRow(db: Db, threadId: number): Promise<Row> {
  const [t] = await db.query<Row>('SELECT * FROM buyer_threads WHERE id = $1', [threadId]);
  if (!t) throw new Error(`Thread ${threadId} not found`);
  return t;
}

/** One seller-agent turn. A quote row is written only when pricing.evaluate() accepted the terms. */
export async function sellerRespond(db: Db, threadId: number, generate: Generate) {
  const thread = await threadRow(db, threadId);
  const { seller, policy, products } = await loadCatalog(db);
  const standing = await liveQuote(db, threadId);

  const recordOffer = async (product: Product, q: QuoteNumbers) => {
    // Repeating the standing offer unchanged does not create a new version.
    const current = await liveQuote(db, threadId);
    if (current?.status === 'draft' && current.sku === product.sku && current.quantity === q.quantity &&
        Number(current.unit_price) === q.unitPrice && current.incoterm === q.incoterm && current.delivery_days === q.deliveryDays)
      return { version: current.version as number };
    await db.query(`UPDATE quote_drafts SET status = 'superseded' WHERE thread_id = $1 AND status = 'draft'`, [threadId]);
    const [{ v }] = await db.query<{ v: number }>('SELECT coalesce(max(version), 0)::int + 1 AS v FROM quote_drafts WHERE thread_id = $1', [threadId]);
    const [quote] = await db.query<{ id: number }>(
      `INSERT INTO quote_drafts (thread_id, version, incoterm, discount_pct, subtotal, total, margin_pct, deposit_pct, delivery_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [threadId, v, q.incoterm, q.discountPct, q.subtotal, q.total, q.marginPct, q.depositPct, q.deliveryDays]);
    await db.query('INSERT INTO quote_items (quote_id, product_id, quantity, unit_price, line_total) VALUES ($1, $2, $3, $4, $5)',
      [quote.id, product.id, q.quantity, q.unitPrice, q.total]);
    await audit(db, threadId, 'seller_agent', 'offer_recorded', { version: v, unitPrice: q.unitPrice, quantity: q.quantity, total: q.total });
    return { version: v };
  };

  const result = await sellerTurn({
    seller, policy, products, generate, recordOffer,
    transcript: await transcriptOf(db, threadId),
    standingOffer: standing ? toOffer(standing) : null,
    locked: thread.status !== 'open',
  });
  for (const t of result.trace.filter((x) => x.result.accepted === false))
    await audit(db, threadId, 'pricing_engine', 'terms_blocked', { tool: t.tool, args: t.args, violations: t.result.violations });
  await addMessage(db, threadId, 'seller_agent', result.text, { trace: result.trace, offer: result.offer });
  return result;
}

export async function buyerRespond(db: Db, threadId: number, generate: Generate) {
  const thread = await threadRow(db, threadId);
  const standing = await liveQuote(db, threadId);
  const result = await buyerTurn({
    mandate: thread.buyer_mandate as BuyerMandate, generate,
    transcript: await transcriptOf(db, threadId),
    standingOffer: standing ? toOffer(standing) : null,
  });
  await addMessage(db, threadId, 'buyer_agent', result.text, { trace: result.trace as TraceEntry[], offer: null });
  return result;
}

/** Buyer acceptance. It only queues the offer for the human seller; it approves nothing. */
export async function acceptOffer(db: Db, threadId: number, actor: 'buyer' | 'buyer_agent') {
  const thread = await threadRow(db, threadId);
  const quote = await liveQuote(db, threadId);
  if (thread.status !== 'open' || !quote || quote.status !== 'draft') throw new Error('There is no open offer to accept.');
  await db.query(`UPDATE quote_drafts SET status = 'pending_approval' WHERE id = $1`, [quote.id]);
  await db.query(`UPDATE buyer_threads SET status = 'awaiting_approval' WHERE id = $1`, [threadId]);
  await addMessage(db, threadId, 'system', `Buyer accepted offer v${quote.version}. Waiting for the seller's approval.`);
  await audit(db, threadId, actor, 'offer_accepted', { quoteId: quote.id, version: quote.version });
  return quote.id as number;
}

/** The human seller's decision. This is the only function that can approve a quote, and no agent tool calls it. */
export async function decideQuote(db: Db, quoteId: number, decision: 'approve' | 'reject', approver: string) {
  const [quote] = await db.query<Row>('SELECT * FROM quote_drafts WHERE id = $1', [quoteId]);
  if (!quote) throw new Error(`Quote ${quoteId} not found`);
  if (quote.status !== 'pending_approval') throw new Error(`Quote is ${quote.status}, not awaiting approval.`);
  if (decision === 'approve') {
    await db.query(`UPDATE quote_drafts SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [quoteId, approver]);
    await addMessage(db, quote.thread_id, 'system', `Seller approved offer v${quote.version}.`);
  } else {
    await db.query(`UPDATE quote_drafts SET status = 'rejected' WHERE id = $1`, [quoteId]);
    await db.query(`UPDATE buyer_threads SET status = 'open' WHERE id = $1`, [quote.thread_id]);
    await addMessage(db, quote.thread_id, 'system', `Seller rejected offer v${quote.version}. The negotiation is open again.`);
  }
  await audit(db, quote.thread_id, approver, decision === 'approve' ? 'quote_approved' : 'quote_rejected', { quoteId, version: quote.version });
  return quote.thread_id as number;
}

/** Agent-to-agent negotiation: buyer agent and seller agent alternate until accept, walk-away or the round limit. */
export async function runAgentNegotiation(db: Db, threadId: number, generate: Generate, maxRounds = 6) {
  for (let round = 0; round < maxRounds; round++) {
    const buyer = await buyerRespond(db, threadId, generate);
    if (buyer.decision === 'accept') return void (await acceptOffer(db, threadId, 'buyer_agent'));
    if (buyer.decision === 'walk_away') {
      await db.query(`UPDATE buyer_threads SET status = 'closed' WHERE id = $1`, [threadId]);
      await addMessage(db, threadId, 'system', 'The buyer ended the negotiation without a deal.');
      return void (await audit(db, threadId, 'buyer_agent', 'walked_away'));
    }
    await sellerRespond(db, threadId, generate);
  }
  await addMessage(db, threadId, 'system', `No agreement after ${maxRounds} rounds.`);
}

const running = new Set<number>();

/** Run agent work after the HTTP response has been sent; the UI polls for new messages. */
export function inBackground(db: Db, threadId: number, work: () => Promise<unknown>) {
  if (running.has(threadId)) return false;
  running.add(threadId);
  work()
    .catch((e: Error) => addMessage(db, threadId, 'system', `Agent error: ${e.message}`).catch(() => undefined))
    .finally(() => running.delete(threadId));
  return true;
}

export async function listThreads(db: Db) {
  // Each row carries the latest offer's product, quantity and total so the list can tell deals apart.
  return db.query(
    `SELECT t.id, t.buyer_name, t.buyer_company, t.buyer_country, t.mode, t.status, t.created_at, t.buyer_mandate,
            lq.product_name, lq.quantity, lq.total
     FROM buyer_threads t
     LEFT JOIN LATERAL (
       SELECT p.name AS product_name, i.quantity, q.total
       FROM quote_drafts q JOIN quote_items i ON i.quote_id = q.id JOIN products p ON p.id = i.product_id
       WHERE q.thread_id = t.id ORDER BY q.version DESC LIMIT 1
     ) lq ON true
     ORDER BY t.id DESC`);
}

export async function getThread(db: Db, threadId: number) {
  const thread = await threadRow(db, threadId);
  const messages = await db.query('SELECT id, role, content, tool_trace, created_at FROM messages WHERE thread_id = $1 ORDER BY id', [threadId]);
  const quotes = await db.query(`${QUOTE_SQL} WHERE q.thread_id = $1 ORDER BY q.version`, [threadId]);
  const invoices = await db.query(
    `SELECT pi.id, pi.quote_id, pi.paypal_invoice_id, pi.kind, pi.amount, pi.status, pi.pay_url
     FROM paypal_invoices pi JOIN quote_drafts q ON q.id = pi.quote_id WHERE q.thread_id = $1 ORDER BY pi.id`, [threadId]);
  return { thread, messages, quotes, invoices, running: running.has(threadId) };
}
