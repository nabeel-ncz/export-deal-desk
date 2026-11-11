import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db.ts';
import { seed } from './seed.ts';
import type { Content, Generate } from './llm.ts';
import { SELLER_TOOLS, BUYER_TOOLS } from './agents.ts';
import { checkMandate, evaluate, limitsFor, splitDeposit, type Product, type SellerPolicy } from './pricing.ts';
import { DEMO_MANDATE, acceptOffer, addMessage, buyerRespond, createThread, decideQuote, getThread, sellerRespond } from './threads.ts';
import type { PayPal } from './paypal.ts';
import { closeDeal, handleWebhook, issueInvoice, refreshThreadPayments, voidQuote } from './payments.ts';

/**
 * A clean, seeded database per test. By default it is the embedded in-memory one.
 * Set TEST_DATABASE_URL to run the same tests on a real Postgres server; that database is wiped before every test,
 * so it must be a scratch database and never the one in DATABASE_URL.
 */
async function freshDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  const db = await openDb(url ? { url } : { memory: true });
  if (url) {
    await db.exec(`TRUNCATE payment_events, paypal_invoices, quote_items, quote_drafts, messages, audit_logs,
      buyer_threads, products, sellers RESTART IDENTITY CASCADE`);
  }
  await seed(db);
  return db;
}

const policy: SellerPolicy = { maxDiscountPct: 5, depositPct: 30, acceptedIncoterms: ['FOB', 'CIF'] };
const basket: Product = {
  id: 1, sku: 'MW-BSK-01', name: 'Basket', description: '', unitCost: 8.2, listPrice: 16, minPrice: 14,
  moq: 100, capacityUnits: 500, leadTimeDays: 21,
};
const ok = { quantity: 150, unitPrice: 15.2, incoterm: 'FOB', deliveryDays: 25 };
const codes = (terms: Partial<typeof ok>, product = basket) => evaluate(policy, product, { ...ok, ...terms }).violations.map((v) => v.code);

describe('pricing engine', () => {
  it('accepts an offer exactly at the lowest allowed price', () => {
    expect(limitsFor(policy, basket).minUnitPrice).toBe(15.2);
    expect(evaluate(policy, basket, ok).ok).toBe(true);
  });

  it('rejects one cent below the discount ceiling', () => {
    expect(codes({ unitPrice: 15.19 })).toEqual(['DISCOUNT_TOO_HIGH']);
  });

  it('rejects below the product minimum price even when the discount would allow it', () => {
    const firmFloor = { ...basket, minPrice: 15.8 };
    expect(limitsFor(policy, firmFloor).minUnitPrice).toBe(15.8);
    expect(codes({ unitPrice: 15.5 }, firmFloor)).toEqual(['BELOW_MIN_PRICE']);
  });

  it('rejects the 15% discount from the demo script', () => {
    expect(codes({ unitPrice: 13.6 })).toEqual(['BELOW_MIN_PRICE']);
  });

  it('enforces minimum order, capacity, shipping term and lead time', () => {
    expect(codes({ quantity: 99 })).toEqual(['BELOW_MIN_ORDER']);
    expect(codes({ quantity: 501 })).toEqual(['OVER_CAPACITY']);
    expect(codes({ incoterm: 'DDP' })).toEqual(['INCOTERM_NOT_ACCEPTED']);
    expect(codes({ deliveryDays: 20 })).toEqual(['DELIVERY_TOO_FAST']);
    expect(codes({ incoterm: 'fob' })).toEqual([]);
  });

  it('rejects malformed numbers', () => {
    for (const bad of [{ quantity: 0 }, { quantity: 1.5 }, { unitPrice: NaN }, { unitPrice: -1 }, { deliveryDays: 0 }])
      expect(codes(bad)).toEqual(['INVALID_INPUT']);
  });

  it('calculates totals, discount, margin and deposit in exact cents', () => {
    expect(evaluate(policy, basket, ok).quote).toMatchObject({
      subtotal: 2400, total: 2280, discountPct: 5, marginPct: 46.05, depositAmount: 684, balanceAmount: 1596,
    });
  });

  it('keeps deposit plus balance equal to the total for awkward amounts', () => {
    for (const total of [0.01, 1999.99, 2283.33, 5109.89]) {
      const { depositAmount, balanceAmount } = splitDeposit(total, 30);
      expect(Math.round((depositAmount + balanceAmount) * 100)).toBe(Math.round(total * 100));
    }
  });
});

describe('buyer mandate', () => {
  it('passes an offer inside the mandate and names every breach outside it', () => {
    expect(checkMandate(DEMO_MANDATE, { quantity: 150, unitPrice: 15.4, incoterm: 'FOB', deliveryDays: 30 })).toEqual([]);
    expect(checkMandate(DEMO_MANDATE, { quantity: 200, unitPrice: 15.41, incoterm: 'CIF', deliveryDays: 31 })).toHaveLength(4);
  });
});

/** A scripted stand-in for the model, so tests show what happens when the AI tries to break the rules. */
const scripted = (...replies: Content[]): Generate => async () => {
  const next = replies.shift();
  if (!next) throw new Error('script exhausted');
  return next;
};
const say = (text: string): Content => ({ role: 'model', parts: [{ text }] });
const call = (name: string, args: Record<string, unknown>): Content => ({ role: 'model', parts: [{ functionCall: { name, args } }] });
const offerArgs = (unit_price: number) => ({ sku: 'MW-BSK-01', quantity: 150, unit_price, incoterm: 'FOB', delivery_days: 25 });

describe('agent guardrails', () => {
  let db: Db;
  afterEach(() => db?.close());
  let threadId: number;
  const quotes = async () => (await getThread(db, threadId)).quotes as any[];

  beforeEach(async () => {
    db = await freshDb();
    threadId = await createThread(db, { mode: 'agent', buyerName: 'Dana', mandate: DEMO_MANDATE });
    await addMessage(db, threadId, 'buyer_agent', 'We want 150 baskets at $13.60.');
  });

  it('the model cannot quote below the minimum price', async () => {
    const result = await sellerRespond(db, threadId, scripted(call('propose_offer', offerArgs(12)), say('I cannot go that low.')));
    expect(result.trace[0].result.accepted).toBe(false);
    expect(await quotes()).toHaveLength(0);
  });

  it('the model cannot exceed the permitted discount', async () => {
    await sellerRespond(db, threadId, scripted(call('propose_offer', offerArgs(15.19)), say('Not possible.')));
    expect(await quotes()).toHaveLength(0);
  });

  it('a valid offer is recorded and a newer one supersedes it', async () => {
    await sellerRespond(db, threadId, scripted(call('propose_offer', offerArgs(15.8)), say('Offer one.')));
    await sellerRespond(db, threadId, scripted(call('propose_offer', offerArgs(15.3)), say('Offer two.')));
    expect((await quotes()).map((q) => [q.version, q.status, Number(q.total)])).toEqual([[1, 'superseded', 2370], [2, 'draft', 2295]]);
  });

  it('no negotiating agent has a tool that approves a deal or takes payment', () => {
    const names = [...SELLER_TOOLS, ...BUYER_TOOLS].map((t) => t.name);
    expect(names.sort()).toEqual(['accept_offer', 'evaluate_terms', 'propose_offer', 'walk_away']);
  });

  it('buyer acceptance only queues the offer; approval is a separate human step that works once', async () => {
    await sellerRespond(db, threadId, scripted(call('propose_offer', offerArgs(15.3)), say('Offer.')));
    const quoteId = await acceptOffer(db, threadId, 'buyer_agent');
    expect((await quotes())[0]).toMatchObject({ status: 'pending_approval', approved_by: null });

    await decideQuote(db, quoteId, 'approve', 'seller');
    expect((await quotes())[0]).toMatchObject({ status: 'approved', approved_by: 'seller' });
    await expect(decideQuote(db, quoteId, 'approve', 'seller')).rejects.toThrow(/not awaiting approval/);
  });

  it('a draft that the buyer has not accepted cannot be approved', async () => {
    await sellerRespond(db, threadId, scripted(call('propose_offer', offerArgs(15.3)), say('Offer.')));
    const [{ id }] = await quotes();
    await expect(decideQuote(db, id, 'approve', 'seller')).rejects.toThrow(/not awaiting approval/);
  });

  it('the seller agent cannot change terms while an offer awaits approval', async () => {
    await sellerRespond(db, threadId, scripted(call('propose_offer', offerArgs(15.3)), say('Offer.')));
    await acceptOffer(db, threadId, 'buyer_agent');
    const result = await sellerRespond(db, threadId, scripted(call('propose_offer', offerArgs(15.9)), say('Cannot change it now.')));
    expect(result.trace[0].result.accepted).toBe(false);
    expect(await quotes()).toHaveLength(1);
  });

  it('the buyer agent cannot accept an offer above its maximum price', async () => {
    await sellerRespond(db, threadId, scripted(call('propose_offer', offerArgs(15.8)), say('Offer.')));
    const result = await buyerRespond(db, threadId, scripted(call('accept_offer', { message: 'Deal.' }), say('Can you do better?')));
    expect(result.decision).toBe('continue');
    expect(result.trace[0].result.accepted).toBe(false);
  });

  it('the buyer agent can accept an offer inside its mandate', async () => {
    await sellerRespond(db, threadId, scripted(call('propose_offer', offerArgs(15.3)), say('Offer.')));
    const result = await buyerRespond(db, threadId, scripted(call('accept_offer', { message: 'We accept.' })));
    expect(result.decision).toBe('accept');
  });
});

/** In-memory stand-in for PayPal: tests flip an invoice to PAID the way a buyer's payment would. */
function fakePayPal() {
  const invoices = new Map<string, string>();
  const state = { invoices, signatureValid: true };
  const api: PayPal = {
    createAndSendInvoice: async () => {
      const id = `INV2-FAKE-${invoices.size + 1}`;
      invoices.set(id, 'UNPAID');
      return { id, status: 'UNPAID', payUrl: `https://pay.example/${id}` };
    },
    getInvoice: async (id) => ({ id, status: invoices.get(id)!, paidAmount: 0 }),
    cancelInvoice: async (id) => void invoices.set(id, 'CANCELLED'),
    verifyWebhook: async () => state.signatureValid,
  };
  return { ...state, api, state };
}

describe('payments', () => {
  let db: Db;
  afterEach(() => db?.close());
  let threadId: number;
  let quoteId: number;
  let pp: ReturnType<typeof fakePayPal>;
  const view = async () => getThread(db, threadId) as Promise<any>;
  const paidEvent = (eventId: string, invoiceId: string) =>
    JSON.stringify({ id: eventId, event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: invoiceId } } });

  beforeEach(async () => {
    db = await freshDb();
    pp = fakePayPal();
    threadId = await createThread(db, { mode: 'agent', buyerName: 'Dana', mandate: DEMO_MANDATE });
    await addMessage(db, threadId, 'buyer_agent', 'We want 150 baskets.');
    await sellerRespond(db, threadId, scripted(call('propose_offer', offerArgs(15.3)), say('Offer.')));
    quoteId = await acceptOffer(db, threadId, 'buyer_agent');
  });

  it('a quote the seller has not approved cannot be invoiced', async () => {
    await expect(issueInvoice(db, pp.api, quoteId, 'note')).rejects.toThrow(/Only a quote approved by the seller/);
    expect(pp.invoices.size).toBe(0);
  });

  it('after approval the seller agent sends the advance invoice through its tool', async () => {
    await decideQuote(db, quoteId, 'approve', 'seller');
    await closeDeal(db, pp.api, scripted(call('send_paypal_invoice', { note: 'Thank you!' }), say('Invoice sent.')), quoteId);
    const v = await view();
    expect(v.invoices.map((i: any) => [i.kind, Number(i.amount), i.status])).toEqual([['deposit', 688.5, 'UNPAID']]);
    expect(v.thread.status).toBe('invoiced');
  });

  it('the invoice is still issued, once, if the model never calls the tool', async () => {
    await decideQuote(db, quoteId, 'approve', 'seller');
    await closeDeal(db, pp.api, scripted(say('All done!')), quoteId);
    expect((await view()).invoices).toHaveLength(1);
    await expect(issueInvoice(db, pp.api, quoteId, 'again')).rejects.toThrow();
  });

  describe('with an advance invoice issued', () => {
    let advanceId: string;
    beforeEach(async () => {
      await decideQuote(db, quoteId, 'approve', 'seller');
      advanceId = (await issueInvoice(db, pp.api, quoteId, 'note')).paypalInvoiceId;
    });

    it('an unpaid invoice does not mark the order paid', async () => {
      await refreshThreadPayments(db, pp.api, threadId);
      const v = await view();
      expect(v.thread.status).toBe('invoiced');
      expect(v.invoices).toHaveLength(1);
    });

    it('an unverified webhook changes nothing and is not recorded', async () => {
      pp.invoices.set(advanceId, 'PAID');
      pp.state.signatureValid = false;
      expect(await handleWebhook(db, pp.api, {}, paidEvent('WH-1', advanceId))).toBe('rejected');
      expect((await view()).invoices[0].status).toBe('UNPAID');
      expect(await db.query('SELECT 1 FROM payment_events')).toHaveLength(0);
    });

    it('a verified webhook claiming PAID is ignored when PayPal still reports the invoice unpaid', async () => {
      expect(await handleWebhook(db, pp.api, {}, paidEvent('WH-1', advanceId))).toBe('processed');
      expect((await view()).invoices[0].status).toBe('UNPAID');
    });

    it('a paid advance issues the balance invoice, and a duplicate webhook does not issue another', async () => {
      pp.invoices.set(advanceId, 'PAID');
      expect(await handleWebhook(db, pp.api, {}, paidEvent('WH-1', advanceId))).toBe('processed');
      expect(await handleWebhook(db, pp.api, {}, paidEvent('WH-1', advanceId))).toBe('duplicate');
      await refreshThreadPayments(db, pp.api, threadId);
      const v = await view();
      expect(v.invoices.map((i: any) => [i.kind, Number(i.amount), i.status])).toEqual([['deposit', 688.5, 'PAID'], ['balance', 1606.5, 'UNPAID']]);
      expect(v.thread.status).toBe('invoiced');
    });

    it('the order is paid only when PayPal confirms both invoices', async () => {
      pp.invoices.set(advanceId, 'PAID');
      await refreshThreadPayments(db, pp.api, threadId);
      const balanceId = (await view()).invoices[1].paypal_invoice_id;
      pp.invoices.set(balanceId, 'PAID');
      await refreshThreadPayments(db, pp.api, threadId);
      const v = await view();
      expect(v.thread.status).toBe('paid');
      expect(v.quotes[0].status).toBe('paid');
    });

    it('withdrawing the quote cancels its unpaid PayPal invoice and reopens the deal', async () => {
      await voidQuote(db, pp.api, quoteId);
      expect(pp.invoices.get(advanceId)).toBe('CANCELLED');
      const v = await view();
      expect(v.invoices[0].status).toBe('CANCELLED');
      expect(v.thread.status).toBe('open');
    });

    it('a quote with a received payment cannot be withdrawn', async () => {
      pp.invoices.set(advanceId, 'PAID');
      await refreshThreadPayments(db, pp.api, threadId);
      await expect(voidQuote(db, pp.api, quoteId)).rejects.toThrow(/already been received/);
    });
  });
});
