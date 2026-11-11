import { useCallback, useEffect, useRef, useState } from 'react';

interface Seller { name: string; city: string; country: string; max_discount_pct: string; deposit_pct: string; accepted_incoterms: string[] }
interface Product { id: number; sku: string; name: string; list_price: string; min_price: string; moq: number; lead_time_days: number }
interface ThreadRow { id: number; buyer_name: string; buyer_company: string | null; mode: 'human' | 'agent'; status: string }
interface Trace { tool: string; args: Record<string, any>; result: Record<string, any> }
interface Offer { version: number; quantity: number; unitPrice: number; total: number; incoterm: string; deliveryDays: number; depositPct: number; depositAmount: number; productName: string }
interface Msg { id: number; role: string; content: string; tool_trace: { trace?: Trace[]; offer?: Offer | null } | null }
interface Quote {
  id: number; version: number; status: string; incoterm: string; discount_pct: string; total: string; margin_pct: string;
  deposit_pct: string; delivery_days: number; quantity: number; unit_price: string; product_name: string;
}
interface Detail { thread: ThreadRow; messages: Msg[]; quotes: Quote[]; running: boolean }
interface Mandate { quantity: number; targetUnitPrice: number; maxUnitPrice: number; maxDeliveryDays: number }

const usd = (v: string | number) => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json as T;
}

const STATUS: Record<string, string> = {
  open: 'Negotiating', awaiting_approval: 'Awaiting seller approval', invoiced: 'Invoiced', paid: 'Paid', closed: 'Closed',
};

function TraceLine({ t }: { t: Trace }) {
  const blocked = t.result.accepted === false;
  const terms = t.args.unit_price !== undefined ? `${t.args.quantity} units at ${usd(t.args.unit_price)}` : '';
  const reasons: string[] = (t.result.violations ?? []).map((v: { message: string }) => v.message).concat(t.result.reasons ?? []);
  const label =
    t.tool === 'propose_offer' ? (blocked ? `Offer blocked by pricing rules: ${terms}` : `Offer passed pricing rules: ${terms}`)
    : t.tool === 'evaluate_terms' ? (blocked ? `Rule check failed: ${terms}` : `Rule check passed: ${terms}`)
    : t.tool === 'accept_offer' ? (blocked ? 'Acceptance blocked by buyer mandate' : 'Acceptance within buyer mandate')
    : 'Buyer agent ended the negotiation';
  return <div className={`trace ${blocked ? 'blocked' : 'passed'}`}>{label}{reasons.length ? ` — ${reasons.join(' ')}` : ''}</div>;
}

function Message({ m }: { m: Msg }) {
  if (m.role === 'system') return <div className="msg system">{m.content}</div>;
  const seller = m.role.startsWith('seller');
  const who = m.role === 'seller_agent' ? 'Seller agent' : m.role === 'buyer_agent' ? 'Buyer agent' : 'Buyer';
  const offer = m.tool_trace?.offer;
  return (
    <div className={`msg ${seller ? 'seller' : 'buyer'}`}>
      <div className="who">{who}</div>
      {m.tool_trace?.trace?.map((t, i) => <TraceLine key={i} t={t} />)}
      <div className="bubble">{m.content}</div>
      {offer && (
        <div className="offer">
          <b>Formal offer v{offer.version}: {usd(offer.total)}</b>
          {offer.quantity} × {offer.productName} at {usd(offer.unitPrice)} · {offer.incoterm} · ships in {offer.deliveryDays} days · {offer.depositPct}% advance ({usd(offer.depositAmount)})
        </div>
      )}
    </div>
  );
}

function DealRoom({ id, onChange }: { id: number; onChange: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const count = d?.messages.length ?? 0;

  const load = useCallback(() => api<Detail>(`/api/threads/${id}`).then(setD).catch((e: Error) => setError(e.message)), [id]);
  useEffect(() => { setD(null); setError(null); load(); const t = setInterval(load, 1500); return () => clearInterval(t); }, [load]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [count]);

  const act = (path: string, body: unknown) =>
    api(path, body).then(() => { setError(null); load(); onChange(); }).catch((e: Error) => setError(e.message));

  if (!d) return <section className="card tight"><p className="muted">{error ?? 'Loading deal…'}</p></section>;
  const { thread, messages, quotes, running } = d;
  const pending = quotes.find((q) => q.status === 'pending_approval');
  const approved = quotes.find((q) => q.status === 'approved');
  const draft = quotes.find((q) => q.status === 'draft');
  const human = thread.mode === 'human';

  return (
    <div className="stack">
      <section className="card tight">
        <h2>{thread.buyer_company ?? thread.buyer_name} <span className="chip">{human ? 'Human buyer' : 'Buyer agent'}</span> <span className="chip">{STATUS[thread.status] ?? thread.status}</span></h2>
        <div className="chat" aria-live="polite">
          {messages.map((m) => <Message key={m.id} m={m} />)}
          {running && <div className="msg system">{human ? 'Seller agent is replying…' : 'Agents are negotiating…'}</div>}
          <div ref={end} />
        </div>
        {human && thread.status === 'open' && (
          <form onSubmit={(e) => { e.preventDefault(); if (reply.trim()) act(`/api/threads/${id}/messages`, { content: reply }).then(() => setReply('')); }}>
            <label htmlFor="reply">Your reply as the buyer</label>
            <textarea id="reply" value={reply} onChange={(e) => setReply(e.target.value)} maxLength={2000} />
            <div className="actions">
              <button type="submit" disabled={running || !reply.trim()}>Send</button>
              {draft && <button type="button" className="ghost" disabled={running} onClick={() => act(`/api/threads/${id}/accept`, {})}>Accept offer v{draft.version}</button>}
            </div>
          </form>
        )}
        {error && <p className="chip bad">{error}</p>}
      </section>

      {pending && (
        <section className="card tight approval">
          <h2>Seller approval required</h2>
          <p className="muted">The agents cannot approve a deal. Nothing is invoiced until you decide.</p>
          <dl className="kv">
            <div><dt>Product</dt><dd>{pending.quantity} × {pending.product_name}</dd></div>
            <div><dt>Unit price</dt><dd>{usd(pending.unit_price)}</dd></div>
            <div><dt>Total</dt><dd>{usd(pending.total)}</dd></div>
            <div><dt>Discount</dt><dd>{Number(pending.discount_pct)}%</dd></div>
            <div><dt>Your margin</dt><dd>{Number(pending.margin_pct)}%</dd></div>
            <div><dt>Terms</dt><dd>{pending.incoterm}, {pending.delivery_days} days</dd></div>
            <div><dt>Advance</dt><dd>{Number(pending.deposit_pct)}%</dd></div>
          </dl>
          <div className="actions">
            <button onClick={() => act(`/api/quotes/${pending.id}/decision`, { decision: 'approve' })}>Approve offer v{pending.version}</button>
            <button className="danger" onClick={() => act(`/api/quotes/${pending.id}/decision`, { decision: 'reject' })}>Reject</button>
          </div>
        </section>
      )}
      {approved && (
        <section className="card tight">
          <h2>Approved: {usd(approved.total)}</h2>
          <p className="muted">Offer v{approved.version} is approved. The PayPal invoice step is not built yet.</p>
        </section>
      )}
    </div>
  );
}

export function App() {
  const [catalog, setCatalog] = useState<{ seller: Seller; products: Product[] } | null>(null);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [mandate, setMandate] = useState<Mandate | null>(null);
  const [message, setMessage] = useState('Hi, we need 150 handmade storage baskets for our stores. Can you offer a better price and delivery within 30 days?');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadThreads = useCallback(() => api<ThreadRow[]>('/api/threads').then(setThreads).catch((e: Error) => setError(e.message)), []);
  useEffect(() => {
    api<{ seller: Seller; products: Product[] }>('/api/seller').then(setCatalog).catch((e: Error) => setError(e.message));
    api<Mandate>('/api/demo-mandate').then(setMandate).catch(() => undefined);
    loadThreads();
    const t = setInterval(loadThreads, 4000);
    return () => clearInterval(t);
  }, [loadThreads]);

  const start = (body: unknown) => {
    setBusy(true);
    api<{ id: number }>('/api/threads', body)
      .then(({ id }) => { setSelected(id); setError(null); loadThreads(); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const field = (key: keyof Mandate, label: string, step: string) => mandate && (
    <div>
      <label htmlFor={key}>{label}</label>
      <input id={key} type="number" step={step} min="0" value={mandate[key]} onChange={(e) => setMandate({ ...mandate, [key]: Number(e.target.value) })} />
    </div>
  );

  return (
    <main className="wide">
      <h1>Export Deal Desk</h1>
      <p className="muted">{catalog ? `${catalog.seller.name} · ${catalog.seller.city}, ${catalog.seller.country}` : 'Loading…'}</p>
      {error && <p className="chip bad">{error}</p>}

      <div className="layout" style={{ marginTop: 16 }}>
        <div className="stack">
          <section className="card tight">
            <h2>Run an agent-to-agent deal</h2>
            <p className="muted">A US retailer's buying agent negotiates with your sales agent. Set the buyer's mandate.</p>
            <div className="row">{field('quantity', 'Quantity', '1')}{field('maxDeliveryDays', 'Deliver within (days)', '1')}</div>
            <div className="row">{field('targetUnitPrice', 'Target price ($)', '0.05')}{field('maxUnitPrice', 'Maximum price ($)', '0.05')}</div>
            <button disabled={busy || !mandate} onClick={() => start({ mode: 'agent', mandate })}>Start negotiation</button>
          </section>

          <section className="card tight">
            <h2>Or enquire as a buyer yourself</h2>
            <label htmlFor="enquiry">Your enquiry</label>
            <textarea id="enquiry" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} />
            <button className="ghost" disabled={busy || !message.trim()} onClick={() => start({ mode: 'human', message, buyerName: 'Walk-in buyer' })}>Send enquiry</button>
          </section>

          <section className="card tight">
            <h2>Deals</h2>
            {threads.length === 0 && <p className="muted">No deals yet.</p>}
            {threads.map((t) => (
              <button key={t.id} className={`deal ${selected === t.id ? 'on' : ''}`} onClick={() => setSelected(t.id)}>
                #{t.id} {t.buyer_company ?? t.buyer_name}<br />
                <span className="muted">{t.mode === 'agent' ? 'Buyer agent' : 'Human buyer'} · {STATUS[t.status] ?? t.status}</span>
              </button>
            ))}
          </section>
        </div>

        <div className="stack">
          {selected ? <DealRoom key={selected} id={selected} onChange={loadThreads} /> : (
            <section className="card tight"><p className="muted">Start a negotiation or pick a deal to open its deal room.</p></section>
          )}
          {catalog && (
            <section className="card tight">
              <h2>Rules the seller agent cannot break</h2>
              <div className="chips">
                <span className="chip">Max discount {Number(catalog.seller.max_discount_pct)}%</span>
                <span className="chip">Advance {Number(catalog.seller.deposit_pct)}%</span>
                <span className="chip">Shipping terms {catalog.seller.accepted_incoterms.join(' / ')}</span>
                <span className="chip">Seller approval required</span>
              </div>
              <div className="scroll" style={{ marginTop: 12 }}>
                <table>
                  <thead><tr><th>SKU</th><th>Product</th><th className="num">List</th><th className="num">Floor</th><th className="num">Min order</th><th className="num">Lead time</th></tr></thead>
                  <tbody>
                    {catalog.products.map((p) => (
                      <tr key={p.id}><td>{p.sku}</td><td>{p.name}</td><td className="num">{usd(p.list_price)}</td><td className="num">{usd(p.min_price)}</td><td className="num">{p.moq}</td><td className="num">{p.lead_time_days} days</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
