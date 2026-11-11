/**
 * Deterministic commercial rules. No AI in this file.
 * The agents can only make an offer by passing it through evaluate(); nothing else creates a quote.
 * All arithmetic is done in integer cents.
 */

export interface SellerPolicy { maxDiscountPct: number; depositPct: number; acceptedIncoterms: string[] }

export interface Product {
  id: number; sku: string; name: string; description: string;
  unitCost: number; listPrice: number; minPrice: number;
  moq: number; capacityUnits: number; leadTimeDays: number;
}

export interface Terms { quantity: number; unitPrice: number; incoterm: string; deliveryDays: number }

export type ViolationCode =
  | 'INVALID_INPUT' | 'BELOW_MIN_ORDER' | 'OVER_CAPACITY' | 'BELOW_MIN_PRICE'
  | 'DISCOUNT_TOO_HIGH' | 'INCOTERM_NOT_ACCEPTED' | 'DELIVERY_TOO_FAST';

export interface Violation { code: ViolationCode; message: string }

export interface Limits {
  minUnitPrice: number; minQuantity: number; maxQuantity: number; minDeliveryDays: number; incoterms: string[];
}

export interface QuoteNumbers extends Terms {
  subtotal: number;      // quantity x list price
  discountPct: number;   // off list price
  total: number;         // quantity x agreed unit price
  marginPct: number;     // (unit price - unit cost) / unit price
  depositPct: number;
  depositAmount: number;
  balanceAmount: number;
}

export interface Evaluation { ok: boolean; violations: Violation[]; limits: Limits; quote: QuoteNumbers | null }

const cents = (n: number) => Math.round(n * 100);
const dollars = (c: number) => c / 100;
const pct2 = (n: number) => Math.round(n * 100) / 100;
const money = (c: number) => `$${dollars(c).toFixed(2)}`;

/** Advance and balance always add up to the total exactly. */
export function splitDeposit(total: number, depositPct: number) {
  const totalC = cents(total);
  const depositC = Math.round((totalC * depositPct) / 100);
  return { depositAmount: dollars(depositC), balanceAmount: dollars(totalC - depositC) };
}

export function limitsFor(policy: SellerPolicy, product: Product): Limits {
  // The lowest price is whichever is higher: the product's own floor or list price less the maximum discount.
  const discountFloorC = Math.ceil((cents(product.listPrice) * (100 - policy.maxDiscountPct)) / 100 - 1e-9);
  return {
    minUnitPrice: dollars(Math.max(cents(product.minPrice), discountFloorC)),
    minQuantity: product.moq,
    maxQuantity: product.capacityUnits,
    minDeliveryDays: product.leadTimeDays,
    incoterms: policy.acceptedIncoterms,
  };
}

export function evaluate(policy: SellerPolicy, product: Product, terms: Terms): Evaluation {
  const limits = limitsFor(policy, product);
  const { quantity, unitPrice, deliveryDays } = terms;
  const incoterm = String(terms.incoterm ?? '').trim().toUpperCase();

  if (!Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice <= 0 ||
      !Number.isInteger(deliveryDays) || deliveryDays <= 0) {
    return {
      ok: false, limits, quote: null,
      violations: [{ code: 'INVALID_INPUT', message: 'Quantity and delivery days must be positive whole numbers, and unit price a positive amount.' }],
    };
  }

  const unitC = cents(unitPrice);
  const listC = cents(product.listPrice);
  const violations: Violation[] = [];

  if (quantity < product.moq)
    violations.push({ code: 'BELOW_MIN_ORDER', message: `Minimum order for ${product.sku} is ${product.moq} units.` });
  if (quantity > product.capacityUnits)
    violations.push({ code: 'OVER_CAPACITY', message: `Available capacity for ${product.sku} is ${product.capacityUnits} units.` });
  if (unitC < cents(product.minPrice))
    violations.push({ code: 'BELOW_MIN_PRICE', message: `${money(unitC)} is below the minimum selling price. Lowest allowed is ${money(cents(limits.minUnitPrice))}.` });
  else if (unitC < cents(limits.minUnitPrice))
    violations.push({ code: 'DISCOUNT_TOO_HIGH', message: `${money(unitC)} exceeds the maximum discount of ${policy.maxDiscountPct}%. Lowest allowed is ${money(cents(limits.minUnitPrice))}.` });
  if (!policy.acceptedIncoterms.includes(incoterm))
    violations.push({ code: 'INCOTERM_NOT_ACCEPTED', message: `Shipping term must be one of: ${policy.acceptedIncoterms.join(', ')}.` });
  if (deliveryDays < product.leadTimeDays)
    violations.push({ code: 'DELIVERY_TOO_FAST', message: `Production lead time for ${product.sku} is ${product.leadTimeDays} days.` });

  if (violations.length) return { ok: false, violations, limits, quote: null };

  const totalC = unitC * quantity;
  const total = dollars(totalC);
  return {
    ok: true, violations, limits,
    quote: {
      quantity, unitPrice: dollars(unitC), incoterm, deliveryDays,
      subtotal: dollars(listC * quantity),
      discountPct: pct2(Math.max(0, ((listC - unitC) / listC) * 100)),
      total,
      marginPct: pct2(((unitC - cents(product.unitCost)) / unitC) * 100),
      depositPct: policy.depositPct,
      ...splitDeposit(total, policy.depositPct),
    },
  };
}

/** The buyer agent's side of the guardrail: what its employer allows it to accept. */
export interface BuyerMandate {
  company: string; country: string; contactName: string; need: string;
  quantity: number; targetUnitPrice: number; maxUnitPrice: number;
  maxDeliveryDays: number; incoterm: string; mustHaves: string[];
}

export function checkMandate(m: BuyerMandate, offer: Terms): string[] {
  const reasons: string[] = [];
  if (cents(offer.unitPrice) > cents(m.maxUnitPrice))
    reasons.push(`Unit price $${offer.unitPrice.toFixed(2)} is above your maximum of $${m.maxUnitPrice.toFixed(2)}.`);
  if (offer.quantity !== m.quantity)
    reasons.push(`Quantity ${offer.quantity} does not match the ${m.quantity} units you are authorised to buy.`);
  if (offer.deliveryDays > m.maxDeliveryDays)
    reasons.push(`Delivery in ${offer.deliveryDays} days is later than your limit of ${m.maxDeliveryDays} days.`);
  if (offer.incoterm.toUpperCase() !== m.incoterm.toUpperCase())
    reasons.push(`Shipping term ${offer.incoterm} is not the ${m.incoterm} you require.`);
  return reasons;
}
