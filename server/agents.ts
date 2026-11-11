import type { Content, Generate, Part, ToolDecl } from './llm.ts';
import { checkMandate, evaluate, type BuyerMandate, type Product, type QuoteNumbers, type SellerPolicy } from './pricing.ts';

/**
 * Two agents with opposing mandates. The model writes the conversation and decides what to try;
 * every number that counts goes through deterministic code in pricing.ts.
 * Neither agent has a tool that approves a deal or creates a payment.
 */

export interface Offer extends QuoteNumbers { version: number; sku: string; productName: string }
export interface Turn { role: 'buyer' | 'seller'; text: string; offer?: Offer | null }
export interface TraceEntry { tool: string; args: Record<string, unknown>; result: Record<string, unknown> }
export interface SellerProfile { name: string; city: string; country: string }

const usd = (n: number) => `$${n.toFixed(2)}`;

export const describeOffer = (o: Offer) =>
  `[FORMAL OFFER v${o.version}: ${o.quantity} x ${o.productName} (${o.sku}) at ${usd(o.unitPrice)} per unit = ${usd(o.total)} total, ` +
  `${o.incoterm}, ships in ${o.deliveryDays} days, ${o.depositPct}% advance (${usd(o.depositAmount)}) by PayPal invoice]`;

const termsParams = {
  type: 'OBJECT',
  properties: {
    sku: { type: 'STRING', description: 'Product SKU from the catalogue' },
    quantity: { type: 'INTEGER' },
    unit_price: { type: 'NUMBER', description: 'USD per unit' },
    incoterm: { type: 'STRING', description: 'Shipping term, e.g. FOB or CIF' },
    delivery_days: { type: 'INTEGER', description: 'Days from order confirmation to shipment' },
  },
  required: ['sku', 'quantity', 'unit_price', 'incoterm', 'delivery_days'],
};

export const SELLER_TOOLS: ToolDecl[] = [
  { name: 'evaluate_terms', description: 'Check whether terms are allowed by company rules without making an offer. Use it to test a buyer counter-proposal.', parameters: termsParams },
  { name: 'propose_offer', description: 'Make a formal offer to the buyer. It is recorded only if company rules allow it; otherwise it is rejected with the reasons.', parameters: termsParams },
];

const messageParam = { type: 'OBJECT', properties: { message: { type: 'STRING', description: 'What to say to the seller' } }, required: ['message'] };

export const BUYER_TOOLS: ToolDecl[] = [
  { name: 'accept_offer', description: "Accept the seller's latest formal offer. Refused if the offer is outside your mandate.", parameters: messageParam },
  { name: 'walk_away', description: 'End the negotiation without a deal.', parameters: messageParam },
];

const textOf = (c: Content) => c.parts.map((p) => p.text ?? '').join('').trim();
const callsOf = (c: Content) => c.parts.filter((p) => p.functionCall).map((p) => p.functionCall!);
const respond = (fc: { name: string; id?: string }, response: Record<string, unknown>): Part =>
  ({ functionResponse: { name: fc.name, response, ...(fc.id ? { id: fc.id } : {}) } });

function sellerSystem(seller: SellerProfile, policy: SellerPolicy, products: Product[], standing: Offer | null, locked: boolean) {
  const catalogue = products
    .map((p) => `- ${p.sku}: ${p.name}. ${p.description} List price ${usd(p.listPrice)} per unit. Minimum order ${p.moq} units. Lead time ${p.leadTimeDays} days.`)
    .join('\n');
  return `You are the export sales agent for ${seller.name}, an exporter in ${seller.city}, ${seller.country}. You negotiate with overseas wholesale buyers by chat.

Catalogue (USD):
${catalogue}

Shipping terms offered: ${policy.acceptedIncoterms.join(', ')}. Payment: ${policy.depositPct}% advance by PayPal invoice, balance before shipment.

How you work:
- To make an offer you need the product, quantity, shipping term and required delivery time. Ask only for what is missing, at most two questions per message.
- Call propose_offer before stating any price or terms as an offer. Only offers that tool accepts exist. Never quote a price it has not accepted. Use evaluate_terms to test a buyer's counter-proposal.
- The tools enforce company rules. If they reject terms, do not retry the same numbers. Tell the buyer plainly what you cannot do and propose the closest alternative that is allowed.
- Negotiate like a good salesperson: open at or near list price, concede in small steps, and ask for something in return such as a larger quantity or flexible delivery. Do not jump straight to your lowest price.
- Never reveal costs, margins or internal limits, and never mention tools or rules engines.
- You cannot approve deals. When the buyer accepts, the offer goes to the human seller for approval and a PayPal invoice follows. Never say a deal is final or that an invoice has been sent.
- Plain text only, no markdown, under 90 words.

${standing ? `Your standing offer: ${describeOffer(standing)}` : 'You have not made a formal offer yet.'}${locked ? '\nAn offer is awaiting seller approval, so you cannot make new offers right now.' : ''}`;
}

export async function sellerTurn(p: {
  seller: SellerProfile; policy: SellerPolicy; products: Product[];
  transcript: Turn[]; standingOffer: Offer | null; locked: boolean; generate: Generate;
  recordOffer: (product: Product, quote: QuoteNumbers) => Promise<{ version: number }>;
}): Promise<{ text: string; trace: TraceEntry[]; offer: Offer | null }> {
  const contents: Content[] = p.transcript.map((t) => ({ role: t.role === 'buyer' ? 'user' : 'model', parts: [{ text: t.text }] }));
  const trace: TraceEntry[] = [];
  const state: { offer: Offer | null } = { offer: null };

  const runTool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const product = p.products.find((x) => x.sku.toLowerCase() === String(args.sku ?? '').toLowerCase());
    if (!product) return { accepted: false, violations: [{ code: 'UNKNOWN_PRODUCT', message: `No product with SKU "${args.sku}".` }] };
    const ev = evaluate(p.policy, product, {
      quantity: Number(args.quantity), unitPrice: Number(args.unit_price),
      incoterm: String(args.incoterm ?? ''), deliveryDays: Number(args.delivery_days),
    });
    if (!ev.ok || !ev.quote) return { accepted: false, violations: ev.violations, allowed: ev.limits };
    const { marginPct: _private, ...shown } = ev.quote; // the model never sees the margin
    if (name === 'evaluate_terms') return { accepted: true, terms: shown };
    if (p.locked) return { accepted: false, violations: [{ code: 'THREAD_LOCKED', message: 'An offer is awaiting seller approval. No new offers can be made.' }] };
    const { version } = await p.recordOffer(product, ev.quote);
    state.offer = { ...ev.quote, version, sku: product.sku, productName: product.name };
    return { accepted: true, offer: { version, ...shown } };
  };

  for (let step = 0; step < 5; step++) {
    const reply = await p.generate({
      system: sellerSystem(p.seller, p.policy, p.products, state.offer ?? p.standingOffer, p.locked),
      contents, tools: SELLER_TOOLS, temperature: 0.6,
    });
    const calls = callsOf(reply);
    if (!calls.length) {
      const text = textOf(reply);
      if (text) return { text, trace, offer: state.offer };
      break;
    }
    contents.push(reply);
    const responses: Part[] = [];
    for (const fc of calls) {
      const known = SELLER_TOOLS.some((t) => t.name === fc.name);
      const result = known ? await runTool(fc.name, fc.args ?? {}) : { accepted: false, violations: [{ code: 'UNKNOWN_TOOL', message: `No tool named ${fc.name}.` }] };
      trace.push({ tool: fc.name, args: fc.args ?? {}, result });
      responses.push(respond(fc, result));
    }
    contents.push({ role: 'user', parts: responses });
  }
  return {
    text: state.offer
      ? `Here is our formal offer: ${usd(state.offer.unitPrice)} per unit for ${state.offer.quantity} units.`
      : 'Let me check the details with my team and come back to you shortly.',
    trace, offer: state.offer,
  };
}

/** Offered to the seller agent only after the human seller has approved a quote. It carries no amounts. */
export const INVOICE_TOOL: ToolDecl = {
  name: 'send_paypal_invoice',
  description: 'Create and send the PayPal invoice for the offer the human seller approved. Amounts are fixed by that offer; you supply only a short note for the buyer.',
  parameters: { type: 'OBJECT', properties: { note: { type: 'STRING', description: 'One or two sentences shown to the buyer on the invoice' } }, required: ['note'] },
};

export async function sellerClosingTurn(p: {
  offer: Offer; transcript: Turn[]; generate: Generate;
  issueInvoice: (note: string) => Promise<Record<string, unknown>>;
}): Promise<{ text: string; trace: TraceEntry[] }> {
  const system = `You are an export sales agent closing a deal. The human seller has approved this offer: ${describeOffer(p.offer)}
Call send_paypal_invoice once with a short, warm note for the buyer. Then tell the buyer in plain text, under 60 words, that the PayPal invoice has been sent, stating the amount the tool returned and what happens next. Do not invent amounts or links.`;
  const contents: Content[] = [
    ...p.transcript.map((t): Content => ({ role: t.role === 'buyer' ? 'user' : 'model', parts: [{ text: t.text }] })),
    { role: 'user', parts: [{ text: `[The seller has approved offer v${p.offer.version}. Send the PayPal invoice now.]` }] },
  ];
  const trace: TraceEntry[] = [];
  for (let step = 0; step < 3; step++) {
    const reply = await p.generate({ system, contents, tools: [INVOICE_TOOL], temperature: 0.4 });
    const calls = callsOf(reply);
    if (!calls.length) return { text: textOf(reply) || 'Your PayPal invoice has been sent.', trace };
    contents.push(reply);
    const responses: Part[] = [];
    for (const fc of calls) {
      const result = fc.name === INVOICE_TOOL.name
        ? await p.issueInvoice(String(fc.args?.note ?? '')).catch((e: Error) => ({ sent: false, error: e.message }))
        : { sent: false, error: `No tool named ${fc.name}.` };
      trace.push({ tool: fc.name, args: fc.args ?? {}, result });
      responses.push(respond(fc, result));
    }
    contents.push({ role: 'user', parts: responses });
  }
  return { text: 'Your PayPal invoice has been sent.', trace };
}

function buyerSystem(m: BuyerMandate) {
  return `You are ${m.contactName}, purchasing agent for ${m.company} (${m.country}). You are negotiating by chat with an exporter's sales agent.

Your mandate from your employer:
- Need: ${m.need}
- Quantity: exactly ${m.quantity} units
- Target price: ${usd(m.targetUnitPrice)} per unit. Absolute maximum: ${usd(m.maxUnitPrice)} per unit.
- Delivery: shipped within ${m.maxDeliveryDays} days
- Shipping term: ${m.incoterm}
${m.mustHaves.length ? `- Must have: ${m.mustHaves.join('; ')}` : ''}

How you work:
- Open with a short enquiry that states your need and asks for your target price.
- Negotiate firmly and politely. Move toward your maximum in small steps and never reveal it.
- The seller's binding offers appear as [FORMAL OFFER ...]. Only those count.
- When the latest formal offer satisfies every point of your mandate and you judge it is the best you will get, call accept_offer.
- If it becomes clear the seller cannot meet your mandate, call walk_away.
- Otherwise reply in plain text, no markdown, under 70 words.`;
}

export async function buyerTurn(p: {
  mandate: BuyerMandate; transcript: Turn[]; standingOffer: Offer | null; generate: Generate;
}): Promise<{ text: string; decision: 'continue' | 'accept' | 'walk_away'; trace: TraceEntry[] }> {
  const contents: Content[] = p.transcript.map((t) => ({
    role: t.role === 'seller' ? 'user' : 'model',
    parts: [{ text: t.role === 'seller' && t.offer ? `${t.text}\n${describeOffer(t.offer)}` : t.text }],
  }));
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'The chat with the seller is open. Send your opening enquiry.' }] });
  const trace: TraceEntry[] = [];

  for (let step = 0; step < 3; step++) {
    const reply = await p.generate({ system: buyerSystem(p.mandate), contents, tools: BUYER_TOOLS, temperature: 0.7 });
    const fc = callsOf(reply)[0];
    if (!fc) {
      const text = textOf(reply);
      if (text) return { text, decision: 'continue', trace };
      break;
    }
    const message = String(fc.args?.message ?? '').trim();
    if (fc.name === 'walk_away') {
      trace.push({ tool: fc.name, args: fc.args ?? {}, result: { ended: true } });
      return { text: message || 'Thank you, but we will not be proceeding.', decision: 'walk_away', trace };
    }
    // accept_offer: the buyer's own mandate is checked in code, not trusted to the model.
    const reasons = !p.standingOffer ? ['The seller has not made a formal offer yet.'] : checkMandate(p.mandate, p.standingOffer);
    const result = { accepted: reasons.length === 0, reasons };
    trace.push({ tool: fc.name, args: fc.args ?? {}, result });
    if (!reasons.length) return { text: message || 'We accept your offer.', decision: 'accept', trace };
    contents.push(reply, { role: 'user', parts: [respond(fc, { ...result, instruction: 'You may not accept this offer. Keep negotiating or walk away.' })] });
  }
  return { text: 'We need a better offer before we can proceed.', decision: 'continue', trace };
}
