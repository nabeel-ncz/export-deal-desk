import type { Db } from './db.ts';
import type { Generate } from './llm.ts';
import type { PayPal } from './paypal.ts';
import { sellerClosingTurn } from './agents.ts';
import { addMessage, audit, quoteWithItem, toOffer, transcriptOf } from './threads.ts';

/**
 * Money movement. Rules enforced here:
 * - only a quote the human seller approved can be invoiced;
 * - a payment counts only after PayPal's own API reports the invoice as PAID
 *   (a webhook is a prompt to go and check, never the source of truth);
 * - unverified webhooks change nothing, and a redelivered webhook is processed once.
 */

type Row = Record<string, any>;
const PAID = 'PAID';
const usd = (n: number) => `$${n.toFixed(2)}`;

export async function issueInvoice(db: Db, paypal: PayPal, quoteId: number, note: string, kind?: 'balance') {
  const q = await quoteWithItem(db, quoteId);
  const offer = toOffer(q);
  const existing = await db.query<Row>(`SELECT * FROM paypal_invoices WHERE quote_id = $1 AND status <> 'CANCELLED'`, [quoteId]);

  let k: 'full' | 'deposit' | 'balance';
  if (kind === 'balance') {
    const advancePaid = existing.some((i) => i.kind === 'deposit' && i.status === PAID);
    if (q.status !== 'invoiced' || !advancePaid || existing.some((i) => i.kind === 'balance'))
      throw new Error('A balance invoice can only follow a paid advance.');
    k = 'balance';
  } else {
    if (q.status !== 'approved') throw new Error(`Quote is ${q.status}. Only a quote approved by the seller can be invoiced.`);
    if (existing.length) throw new Error('This quote already has an invoice.');
    k = offer.depositPct > 0 && offer.depositPct < 100 ? 'deposit' : 'full';
  }

  // PayPal India does not allow partial payments on one invoice, so an advance and a balance are two invoices.
  const amount = k === 'full' ? offer.total : k === 'deposit' ? offer.depositAmount : offer.balanceAmount;
  const order = `${offer.quantity} x ${offer.productName} at ${usd(offer.unitPrice)} (${offer.incoterm})`;
  const inv = await paypal.createAndSendInvoice({
    reference: `DEAL-${q.thread_id}-Q${quoteId}-${k}`,
    note: note.slice(0, 500),
    itemName: k === 'full' ? offer.productName : `${k === 'deposit' ? `${offer.depositPct}% advance` : 'Balance'} for ${order}`,
    quantity: k === 'full' ? offer.quantity : 1,
    unitAmount: k === 'full' ? offer.unitPrice : amount,
  });

  await db.query(
    'INSERT INTO paypal_invoices (quote_id, paypal_invoice_id, kind, amount, status, pay_url) VALUES ($1, $2, $3, $4, $5, $6)',
    [quoteId, inv.id, k, amount, inv.status, inv.payUrl]);
  await db.query(`UPDATE quote_drafts SET status = 'invoiced' WHERE id = $1`, [quoteId]);
  await db.query(`UPDATE buyer_threads SET status = 'invoiced' WHERE id = $1`, [q.thread_id]);
  await audit(db, q.thread_id, 'paypal', 'invoice_issued', { paypalInvoiceId: inv.id, kind: k, amount });
  return { kind: k, amount, paypalInvoiceId: inv.id, payUrl: inv.payUrl };
}

/** After the seller approves, the seller agent sends the invoice. If the model fails to, code sends it. */
export async function closeDeal(db: Db, paypal: PayPal, generate: Generate, quoteId: number) {
  const q = await quoteWithItem(db, quoteId);
  let issued = false;
  try {
    const result = await sellerClosingTurn({
      offer: toOffer(q), generate, transcript: await transcriptOf(db, q.thread_id),
      issueInvoice: async (note) => {
        if (issued) return { sent: true, alreadySent: true };
        const inv = await issueInvoice(db, paypal, quoteId, note);
        issued = true;
        return { sent: true, kind: inv.kind, amount: inv.amount, currency: 'USD' };
      },
    });
    if (issued) await addMessage(db, q.thread_id, 'seller_agent', result.text, { trace: result.trace, offer: null });
  } catch (e) {
    await audit(db, q.thread_id, 'seller_agent', 'closing_turn_failed', { error: (e as Error).message });
  }
  if (!issued) {
    const inv = await issueInvoice(db, paypal, quoteId, 'Thank you for your order.');
    await addMessage(db, q.thread_id, 'system', `PayPal invoice issued for ${usd(inv.amount)}.`);
  }
}

/** Ask PayPal for the invoice's real state and act on a change. Safe to call any number of times. */
export async function syncInvoice(db: Db, paypal: PayPal, paypalInvoiceId: string, source: string) {
  const [row] = await db.query<Row>('SELECT * FROM paypal_invoices WHERE paypal_invoice_id = $1', [paypalInvoiceId]);
  if (!row) return null;
  if (row.status === PAID || row.status === 'CANCELLED') return row.status as string;

  const live = await paypal.getInvoice(paypalInvoiceId);
  // Conditional update: if a webhook and a status check race, only one of them sees a changed row.
  const changed = await db.query(
    'UPDATE paypal_invoices SET status = $2, updated_at = now() WHERE id = $1 AND status <> $2 RETURNING id', [row.id, live.status]);
  if (!changed.length || live.status !== PAID) return live.status;

  const q = await quoteWithItem(db, row.quote_id);
  const amount = Number(row.amount);
  await audit(db, q.thread_id, source, 'payment_confirmed', { paypalInvoiceId, kind: row.kind, amount });

  if (row.kind === 'deposit') {
    await addMessage(db, q.thread_id, 'system', `PayPal confirmed the advance payment of ${usd(amount)}.`);
    const balance = await issueInvoice(db, paypal, row.quote_id, 'Balance due before shipment.', 'balance');
    await addMessage(db, q.thread_id, 'system', `Balance invoice issued for ${usd(balance.amount)}.`);
  } else {
    await db.query(`UPDATE quote_drafts SET status = 'paid' WHERE id = $1`, [row.quote_id]);
    await db.query(`UPDATE buyer_threads SET status = 'paid' WHERE id = $1`, [q.thread_id]);
    await addMessage(db, q.thread_id, 'system', `PayPal confirmed payment of ${usd(amount)}. The order is paid in full.`);
  }
  return PAID;
}

/** Fallback for when a webhook is late or not configured: check every open invoice on a deal. */
export async function refreshThreadPayments(db: Db, paypal: PayPal, threadId: number) {
  const open = await db.query<Row>(
    `SELECT pi.paypal_invoice_id FROM paypal_invoices pi JOIN quote_drafts q ON q.id = pi.quote_id
     WHERE q.thread_id = $1 AND pi.status NOT IN ('PAID', 'CANCELLED') ORDER BY pi.id`, [threadId]);
  for (const inv of open) await syncInvoice(db, paypal, inv.paypal_invoice_id, 'status_check');
}

/** Server-side sweep of every unpaid invoice, so confirmation does not depend on a browser tab being open. */
export async function refreshAllOpenPayments(db: Db, paypal: PayPal) {
  const open = await db.query<Row>(`SELECT paypal_invoice_id FROM paypal_invoices WHERE status NOT IN ('PAID', 'CANCELLED') ORDER BY id`);
  for (const inv of open) await syncInvoice(db, paypal, inv.paypal_invoice_id, 'status_check').catch(() => undefined);
}

export async function handleWebhook(
  db: Db, paypal: PayPal, headers: Record<string, string | string[] | undefined>, rawBody: string,
): Promise<'rejected' | 'duplicate' | 'processed'> {
  const verified = await paypal.verifyWebhook(headers, rawBody).catch(() => false);
  if (!verified) {
    await audit(db, null, 'paypal_webhook', 'webhook_rejected', { reason: 'signature not verified' });
    return 'rejected';
  }
  const event = JSON.parse(rawBody) as Row;
  const invoiceId: string | null = event.resource?.invoice?.id ?? event.resource?.id ?? null;
  const inserted = await db.query(
    `INSERT INTO payment_events (paypal_event_id, event_type, paypal_invoice_id, verified, payload)
     VALUES ($1, $2, $3, TRUE, $4::text::jsonb) ON CONFLICT (paypal_event_id) DO NOTHING RETURNING id`,
    [String(event.id), String(event.event_type), invoiceId, rawBody]);
  if (!inserted.length) return 'duplicate';
  if (invoiceId && String(event.event_type).startsWith('INVOICING.INVOICE')) await syncInvoice(db, paypal, invoiceId, 'paypal_webhook');
  return 'processed';
}

/** Seller withdraws an approved or invoiced quote: unpaid PayPal invoices are cancelled and the deal reopens. */
export async function voidQuote(db: Db, paypal: PayPal, quoteId: number) {
  const q = await quoteWithItem(db, quoteId);
  if (q.status !== 'approved' && q.status !== 'invoiced') throw new Error(`Quote is ${q.status} and cannot be withdrawn.`);
  const invoices = await db.query<Row>(`SELECT * FROM paypal_invoices WHERE quote_id = $1 AND status <> 'CANCELLED'`, [quoteId]);
  if (invoices.some((i) => i.status === PAID)) throw new Error('A payment has already been received on this quote.');
  for (const inv of invoices) {
    await paypal.cancelInvoice(inv.paypal_invoice_id);
    await db.query(`UPDATE paypal_invoices SET status = 'CANCELLED', updated_at = now() WHERE id = $1`, [inv.id]);
  }
  await db.query(`UPDATE quote_drafts SET status = 'rejected' WHERE id = $1`, [quoteId]);
  await db.query(`UPDATE buyer_threads SET status = 'open' WHERE id = $1`, [q.thread_id]);
  await addMessage(db, q.thread_id, 'system', `Seller withdrew offer v${q.version}. Its PayPal invoice was cancelled and the negotiation is open again.`);
  await audit(db, q.thread_id, 'seller', 'quote_withdrawn', { quoteId, cancelledInvoices: invoices.map((i) => i.paypal_invoice_id) });
}
