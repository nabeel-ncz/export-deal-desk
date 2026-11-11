import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db.ts';
import { seed } from './seed.ts';
import type { Content, Generate } from './llm.ts';
import { SELLER_TOOLS, BUYER_TOOLS } from './agents.ts';
import { checkMandate, evaluate, limitsFor, splitDeposit, type Product, type SellerPolicy } from './pricing.ts';
import { DEMO_MANDATE, acceptOffer, addMessage, buyerRespond, createThread, decideQuote, getThread, sellerRespond } from './threads.ts';

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
  let threadId: number;
  const quotes = async () => (await getThread(db, threadId)).quotes as any[];

  beforeEach(async () => {
    db = await openDb({ memory: true });
    await seed(db);
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

  it('no agent has a tool that approves a deal or takes payment', () => {
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
