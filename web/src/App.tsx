import { useCallback, useEffect, useRef, useState } from 'react';
import { Arrow, Link, Logo, PriceRail, api, navigate, usd, type RailPoint } from './ui.tsx';

/** The deal desk: start deals, watch the negotiation, approve offers, follow PayPal invoices. */

interface Seller { name: string; city: string; country: string; max_discount_pct: string; deposit_pct: string; accepted_incoterms: string[] }
interface Product { id: number; sku: string; name: string; list_price: string; lowest_price: number; moq: number; lead_time_days: number }
interface Catalog { seller: Seller; products: Product[] }
interface Mandate { quantity: number; targetUnitPrice: number; maxUnitPrice: number; maxDeliveryDays: number; need?: string }
interface ThreadRow { id: number; buyer_name: string; buyer_company: string | null; mode: 'human' | 'agent'; status: string; buyer_mandate?: Mandate | null }
interface Trace { tool: string; args: Record<string, any>; result: Record<string, any> }
interface Offer { version: number; quantity: number; unitPrice: number; total: number; incoterm: string; deliveryDays: number; depositPct: number; depositAmount: number; productName: string }
interface Msg { id: number; role: string; content: string; tool_trace: { trace?: Trace[]; offer?: Offer | null } | null }
interface Quote {
  id: number; version: number; status: string; incoterm: string; discount_pct: string; total: string; margin_pct: string;
  deposit_pct: string; delivery_days: number; quantity: number; unit_price: string; product_name: string; sku: string;
}
interface Invoice { id: number; paypal_invoice_id: string; kind: 'full' | 'deposit' | 'balance'; amount: string; status: string; pay_url: string | null }
interface Detail { thread: ThreadRow; messages: Msg[]; quotes: Quote[]; invoices: Invoice[]; running: boolean }

const KIND = { full: 'Full payment', deposit: 'Advance', balance: 'Balance' };
const STATUS: Record<string, [string, string]> = {
  open: ['Negotiating', 'live'], awaiting_approval: ['Needs approval', ''], invoiced: ['Invoiced', ''],
  paid: ['Paid', 'ok'], closed: ['Closed', 'plain'],
};
const StatusPill = ({ status }: { status: string }) => {
  const [label, tone] = STATUS[status] ?? [status, ''];
  return <span className={`pill ${tone}`}>{label}</span>;
};
const STEPS = ['Enquiry', 'Negotiation', 'Approval', 'Invoice', 'Paid'];
const PRICE_BLOCKS = ['BELOW_MIN_PRICE', 'DISCOUNT_TOO_HIGH'];

function TraceLine({ t }: { t: Trace }) {
  if (t.tool === 'send_paypal_invoice') {
    const sent = t.result.sent === true;
    const what = t.result.amount ? `: ${usd(t.result.amount)} (${KIND[t.result.kind as keyof typeof KIND] ?? t.result.kind})` : '';
    return <div className={`trace ${sent ? 'passed' : 'blocked'}`}>{sent ? `PayPal invoice sent by the agent${what}` : `PayPal invoice not sent. ${t.result.error ?? ''}`}</div>;
  }
  const blocked = t.result.accepted === false;
  const terms = t.args.unit_price !== undefined ? `${t.args.quantity} units at ${usd(t.args.unit_price)}` : '';
  const reasons: string[] = (t.result.violations ?? []).map((v: { message: string }) => v.message).concat(t.result.reasons ?? []);
  const label =
    t.tool === 'propose_offer' ? (blocked ? `Offer blocked by pricing rules: ${terms}.` : `Offer passed pricing rules: ${terms}`)
    : t.tool === 'evaluate_terms' ? (blocked ? `Rule check failed: ${terms}.` : `Rule check passed: ${terms}`)
    : t.tool === 'accept_offer' ? (blocked ? 'Acceptance blocked by the buyer mandate.' : 'Acceptance is within the buyer mandate')
    : 'Buyer agent ended the negotiation';
  return <div className={`trace ${blocked ? 'blocked' : 'passed'}`}><span>{label} {reasons.join(' ')}</span></div>;
}

function Message({ m }: { m: Msg }) {
  if (m.role === 'system') return <div className={`note ${m.content.startsWith('Agent error') ? 'bad' : ''}`}>{m.content}</div>;
  const seller = m.role.startsWith('seller');
  const who = m.role === 'seller_agent' ? 'Seller agent' : m.role === 'buyer_agent' ? 'Buyer agent' : 'Buyer';
  const offer = m.tool_trace?.offer;
  return (
    <div className={`msg ${seller ? 'seller' : 'buyer'}`}>
      <div className="who">{who}</div>
      {m.tool_trace?.trace?.map((t, i) => <TraceLine key={i} t={t} />)}
      <div className="bubble">{m.content}</div>
      {offer && (
        <div className="offer-card">
          <div className="head"><span className="eyebrow">Formal offer v{offer.version}</span><b>{usd(offer.total)}</b></div>
          <p>{offer.quantity} × {offer.productName} at {usd(offer.unitPrice)} · {offer.incoterm} · ships in {offer.deliveryDays} days · {offer.depositPct}% advance ({usd(offer.depositAmount)})</p>
        </div>
      )}
    </div>
  );
}

/** Build the live price rail for a deal from its recorded tool calls and quotes. */
function railFor(d: Detail, catalog: Catalog | null) {
  const traces = d.messages.flatMap((m) => m.tool_trace?.trace ?? []);
  const sku = [...d.quotes].reverse()[0]?.sku
    ?? traces.find((t) => t.args?.sku)?.args.sku
    ?? /[A-Z]{2}-[A-Z]{3}-\d{2}/.exec(d.thread.buyer_mandate?.need ?? '')?.[0];
  const product = catalog?.products.find((p) => p.sku.toLowerCase() === String(sku ?? '').toLowerCase());
  if (!product) return null;

  const rank = { ask: 0, blocked: 1, offer: 2, agreed: 3 };
  const byValue = new Map<number, RailPoint['kind']>();
  const put = (value: number, kind: RailPoint['kind']) => {
    if (!Number.isFinite(value) || value <= 0) return;
    const current = byValue.get(value);
    if (!current || rank[kind] > rank[current]) byValue.set(value, kind);
  };
  if (d.thread.buyer_mandate?.targetUnitPrice) put(Number(d.thread.buyer_mandate.targetUnitPrice), 'ask');
  for (const t of traces) {
    if (t.tool !== 'propose_offer' && t.tool !== 'evaluate_terms') continue;
    const priceBlocked = (t.result.violations ?? []).some((v: { code: string }) => PRICE_BLOCKS.includes(v.code));
    if (priceBlocked) put(Number(t.args.unit_price), 'blocked');
  }
  for (const q of d.quotes) {
    put(Number(q.unit_price), ['pending_approval', 'approved', 'invoiced', 'paid'].includes(q.status) ? 'agreed' : 'offer');
  }
  const points = [...byValue].map(([value, kind]) => ({ value, kind }));
  return { product, points };
}

function DealRoom({ id, catalog }: { id: number; catalog: Catalog | null }) {
  const [d, setD] = useState<Detail | null>(null);
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const count = d?.messages.length ?? 0;

  const load = useCallback(() => api<Detail>(`/api/threads/${id}`).then(setD).catch((e: Error) => setError(e.message)), [id]);
  useEffect(() => { load(); const t = setInterval(load, 1500); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (count > 1) end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [count]);

  // While an invoice is unpaid, ask the server to re-check it with PayPal (the server also sweeps every 15 seconds).
  const awaitingPayment = d?.thread.status === 'invoiced';
  useEffect(() => {
    if (!awaitingPayment) return;
    const t = setInterval(() => { api(`/api/threads/${id}/refresh-payment`, {}).catch(() => undefined); }, 10_000);
    return () => clearInterval(t);
  }, [awaitingPayment, id]);

  const act = (path: string, body: unknown) =>
    api(path, body).then(() => { setError(null); return load(); }).catch((e: Error) => setError(e.message));

  if (!d) {
    return (
      <>
        <Link to="/app" className="back">← All deals</Link>
        <section className="panel" style={{ marginTop: 18 }}>{error ? <p className="banner" style={{ margin: 0 }}>{error}</p> : <p className="muted">Opening the deal…</p>}</section>
      </>
    );
  }

  const { thread, messages, quotes, invoices, running } = d;
  const pending = quotes.find((q) => q.status === 'pending_approval');
  const approved = quotes.find((q) => q.status === 'approved');
  const invoiced = quotes.find((q) => q.status === 'invoiced');
  const draft = quotes.find((q) => q.status === 'draft');
  const liveInvoices = invoices.filter((i) => i.status !== 'CANCELLED');
  const canPay = (i: Invoice) => Boolean(i.pay_url) && i.status !== 'PAID' && i.status !== 'CANCELLED';
  const payable = invoices.some(canPay);
  const human = thread.mode === 'human';
  const stage = thread.status === 'paid' ? 5 : liveInvoices.length ? 3 : pending || approved ? 2 : quotes.length ? 1 : 0;
  const rail = railFor(d, catalog);

  return (
    <>
      <Link to="/app" className="back">← All deals</Link>
      <div className="desk-head" style={{ marginTop: 14 }}>
        <div>
          <p className="eyebrow">Deal #{thread.id} · {human ? 'Human buyer' : 'Buyer agent'}</p>
          <h1>{thread.buyer_company ?? thread.buyer_name}</h1>
        </div>
        <StatusPill status={thread.status} />
      </div>

      <ol className="stepper" aria-label="Deal progress">
        {STEPS.map((s, i) => <li key={s} className={i < stage ? 'done' : i === stage ? 'now' : ''} aria-current={i === stage ? 'step' : undefined}>{s}</li>)}
      </ol>
      {error && <p className="banner" role="alert">{error}</p>}

      <div className="cols room">
        <section className="panel">
          <p className="eyebrow">Conversation</p>
          <div className="chat" aria-live="polite">
            {messages.map((m) => <Message key={m.id} m={m} />)}
            {running && <div className="note">{human ? 'Seller agent is replying' : 'Agents are negotiating'} <span className="typing" aria-hidden="true"><i /><i /><i /></span></div>}
            <div ref={end} />
          </div>
          {human && thread.status === 'open' && (
            <form onSubmit={(e) => { e.preventDefault(); if (reply.trim()) act(`/api/threads/${id}/messages`, { content: reply }).then(() => setReply('')); }}>
              <label className="field" htmlFor="reply">Your reply as the buyer
                <textarea id="reply" value={reply} onChange={(e) => setReply(e.target.value)} maxLength={2000} placeholder="Ask for a better price, a different quantity, faster delivery…" />
              </label>
              <div className="actions">
                <button type="submit" className="btn" disabled={running || !reply.trim()}>Send reply <Arrow /></button>
                {draft && <button type="button" className="btn ghost" disabled={running} onClick={() => act(`/api/threads/${id}/accept`, {})}>Accept offer v{draft.version}</button>}
              </div>
            </form>
          )}
        </section>

        <div className="stack side">
          {pending && (
            <section className="panel accent">
              <p className="eyebrow"><b>Your decision</b> · offer v{pending.version}</p>
              <p className="figure">{usd(pending.total)}</p>
              <p className="muted">The agents cannot approve a deal. Nothing is invoiced until you decide.</p>
              <dl className="kv">
                <div><dt>Order</dt><dd>{pending.quantity} × {pending.product_name}</dd></div>
                <div><dt>Unit price</dt><dd className="num">{usd(pending.unit_price)}</dd></div>
                <div><dt>Discount</dt><dd className="num">{Number(pending.discount_pct)}%</dd></div>
                <div><dt>Your margin</dt><dd className="num">{Number(pending.margin_pct)}%</dd></div>
                <div><dt>Terms</dt><dd>{pending.incoterm} · {pending.delivery_days} days</dd></div>
                <div><dt>Advance</dt><dd className="num">{Number(pending.deposit_pct)}%</dd></div>
              </dl>
              <div className="actions">
                <button className="btn thread" onClick={() => act(`/api/quotes/${pending.id}/decision`, { decision: 'approve' })}>Approve offer <Arrow /></button>
                <button className="btn danger" onClick={() => act(`/api/quotes/${pending.id}/decision`, { decision: 'reject' })}>Reject</button>
              </div>
            </section>
          )}

          {approved && (
            <section className="panel accent">
              <p className="eyebrow"><b>Approved</b> · offer v{approved.version}</p>
              <p className="figure">{usd(approved.total)}</p>
              {running
                ? <p className="muted">The seller agent is sending the PayPal invoice <span className="typing" aria-hidden="true"><i /><i /><i /></span></p>
                : (
                  <>
                    <p className="muted">The PayPal invoice has not been sent. The last note in the conversation says why.</p>
                    <div className="actions"><button className="btn" onClick={() => act(`/api/quotes/${approved.id}/invoice`, {})}>Send PayPal invoice <Arrow /></button></div>
                  </>
                )}
            </section>
          )}

          {invoices.length > 0 && (
            <section className={`panel ${thread.status === 'paid' ? '' : 'accent'}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <p className="eyebrow">PayPal invoices</p>
                {thread.status === 'paid' && <span className="pill ok">Paid in full</span>}
              </div>
              <div className="scroll" style={{ marginTop: 8 }}>
                <table>
                  <thead><tr><th>Invoice</th><th className="n">Amount</th><th>Status</th>{payable && <th><span style={{ position: 'absolute', left: -9999 }}>Pay</span></th>}</tr></thead>
                  <tbody>
                    {invoices.map((i) => (
                      <tr key={i.id}>
                        <td>{KIND[i.kind]}<br /><span className="num muted" style={{ fontSize: 11.5 }}>{i.paypal_invoice_id}</span></td>
                        <td className="n">{usd(i.amount)}</td>
                        <td><span className={`pill ${i.status === 'PAID' ? 'ok' : i.status === 'CANCELLED' ? 'bad' : ''}`}>{i.status.toLowerCase()}</span></td>
                        {payable && <td>{canPay(i) && <a className="btn sm" href={i.pay_url!} target="_blank" rel="noreferrer">Pay <Arrow /></a>}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {thread.status === 'invoiced' && (
                <>
                  <p className="muted" style={{ fontSize: 13.5, marginTop: 12 }}>Sandbox: pay with a test buyer account from outside India. The status changes only after PayPal confirms the payment.</p>
                  <div className="actions">
                    <button className="btn ghost sm" onClick={() => act(`/api/threads/${id}/refresh-payment`, {})}>Check payment now</button>
                    {invoiced && !invoices.some((i) => i.status === 'PAID') && (
                      <button className="btn danger sm" onClick={() => act(`/api/quotes/${invoiced.id}/void`, {})}>Cancel invoice and reopen</button>
                    )}
                  </div>
                </>
              )}
            </section>
          )}

          {rail && (
            <section className="panel">
              <p className="eyebrow">Price rail · {rail.product.sku}</p>
              <PriceRail list={Number(rail.product.list_price)} floor={Number(rail.product.lowest_price)} points={rail.points} />
            </section>
          )}
        </div>
      </div>
    </>
  );
}

function Home({ catalog }: { catalog: Catalog | null }) {
  const [threads, setThreads] = useState<ThreadRow[] | null>(null);
  const [mandate, setMandate] = useState<Mandate | null>(null);
  const [mode, setMode] = useState<'agent' | 'human'>(new URLSearchParams(location.search).get('mode') === 'human' ? 'human' : 'agent');
  const [message, setMessage] = useState('Hi, we need 150 handmade storage baskets for our stores. Can you offer a better price and delivery within 30 days?');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const load = () => api<ThreadRow[]>('/api/threads').then(setThreads).catch((e: Error) => setError(e.message));
    api<Mandate>('/api/demo-mandate').then(setMandate).catch(() => undefined);
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  const start = (body: unknown) => {
    setBusy(true);
    api<{ id: number }>('/api/threads', body)
      .then(({ id }) => navigate(`/app/deals/${id}`))
      .catch((e: Error) => { setError(e.message); setBusy(false); });
  };
  const field = (key: 'quantity' | 'targetUnitPrice' | 'maxUnitPrice' | 'maxDeliveryDays', label: string, step: string) => (
    <label className="field" htmlFor={key}>{label}
      <input id={key} type="number" inputMode="decimal" step={step} min="0" value={mandate?.[key] ?? ''} disabled={!mandate}
        onChange={(e) => mandate && setMandate({ ...mandate, [key]: Number(e.target.value) })} />
    </label>
  );

  return (
    <>
      <div className="desk-head">
        <div><p className="eyebrow">Deal desk</p><h1>Start a deal.</h1></div>
        <p className="muted" style={{ maxWidth: '30em' }}>Run a negotiation between two AI agents, or step in as the buyer. You approve every offer before PayPal is involved.</p>
      </div>
      {error && <p className="banner" role="alert">{error}</p>}

      <div className="cols home">
        <section className="panel accent">
          <p className="eyebrow">New deal</p>
          <div className="tabs" role="tablist" aria-label="Who plays the buyer">
            <button role="tab" aria-selected={mode === 'agent'} onClick={() => setMode('agent')}>Two AI agents</button>
            <button role="tab" aria-selected={mode === 'human'} onClick={() => setMode('human')}>I am the buyer</button>
          </div>
          {mode === 'agent' ? (
            <div role="tabpanel">
              <p className="muted" style={{ marginTop: 12 }}>A US retailer's purchasing agent negotiates with your sales agent. Set what its employer allows it to accept.</p>
              <div className="two">{field('quantity', 'Quantity', '1')}{field('maxDeliveryDays', 'Deliver within (days)', '1')}</div>
              <div className="two">{field('targetUnitPrice', 'Target price (USD)', '0.05')}{field('maxUnitPrice', 'Maximum price (USD)', '0.05')}</div>
              <div className="actions"><button className="btn thread" disabled={busy || !mandate} onClick={() => start({ mode: 'agent', mandate })}>{busy ? 'Starting…' : 'Start negotiation'} <Arrow /></button></div>
            </div>
          ) : (
            <div role="tabpanel">
              <p className="muted" style={{ marginTop: 12 }}>Write to the exporter the way a real buyer would. The seller agent replies.</p>
              <label className="field" htmlFor="enquiry">Your enquiry
                <textarea id="enquiry" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} />
              </label>
              <div className="actions"><button className="btn thread" disabled={busy || !message.trim()} onClick={() => start({ mode: 'human', message, buyerName: 'Walk-in buyer' })}>{busy ? 'Sending…' : 'Send enquiry'} <Arrow /></button></div>
            </div>
          )}
        </section>

        <section className="panel">
          <p className="eyebrow">Deals</p>
          <h2>On the desk</h2>
          {threads === null && <p className="empty">Loading deals…</p>}
          {threads?.length === 0 && <p className="empty">No deals yet. Start one and it will appear here.</p>}
          {threads?.map((t) => (
            <Link key={t.id} to={`/app/deals/${t.id}`} className="deal-row">
              <span className="id">#{t.id}</span>
              <span className="name">{t.buyer_company ?? t.buyer_name}<small>{t.mode === 'agent' ? 'Buyer agent' : 'Human buyer'}</small></span>
              <StatusPill status={t.status} />
              <Arrow />
            </Link>
          ))}
        </section>
      </div>

      {catalog && (
        <section className="panel" style={{ marginTop: 18 }}>
          <p className="eyebrow">Seller rules</p>
          <h2>Lines the agent cannot cross</h2>
          <div className="chips">
            <span className="pill plain">Max discount {Number(catalog.seller.max_discount_pct)}%</span>
            <span className="pill plain">Advance {Number(catalog.seller.deposit_pct)}%</span>
            <span className="pill plain">Shipping {catalog.seller.accepted_incoterms.join(' / ')}</span>
            <span className="pill plain">Seller approval required</span>
          </div>
          <div className="scroll">
            <table>
              <thead><tr><th>SKU</th><th>Product</th><th className="n">List</th><th className="n">Lowest allowed</th><th className="n">Min order</th><th className="n">Lead time</th></tr></thead>
              <tbody>
                {catalog.products.map((p) => (
                  <tr key={p.id}><td className="num">{p.sku}</td><td>{p.name}</td><td className="n">{usd(p.list_price)}</td><td className="n">{usd(p.lowest_price)}</td><td className="n">{p.moq}</td><td className="n">{p.lead_time_days} days</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

export function Desk({ path }: { path: string }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<Catalog>('/api/seller').then(setCatalog).catch((e: Error) => setError(e.message)); }, []);
  const dealId = Number(/^\/app\/deals\/(\d+)/.exec(path)?.[1] ?? 0);

  return (
    <>
      <header className="topbar">
        <div className="wrap">
          <Link to="/" aria-label="TradeThread home" style={{ textDecoration: 'none' }}><Logo /></Link>
          <div className="who">
            {catalog && <span className="name hide-sm">{catalog.seller.name} · {catalog.seller.city}</span>}
            <span className="pill live">Sandbox</span>
            {dealId > 0 && <Link to="/app" className="btn ghost sm hide-sm">All deals</Link>}
          </div>
        </div>
      </header>
      <main className="desk wrap">
        {error && <p className="banner" role="alert">Cannot reach the server: {error}</p>}
        {dealId > 0 ? <DealRoom key={dealId} id={dealId} catalog={catalog} /> : <Home catalog={catalog} />}
      </main>
    </>
  );
}
