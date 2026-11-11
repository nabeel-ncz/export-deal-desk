import { useEffect, useRef, useState } from 'react';
import { Arrow, Link, Logo, PriceRail, REPO, useReveal, type RailPoint } from './ui.tsx';

/**
 * Landing page. Every figure here comes from a deal that was actually run against the PayPal Sandbox
 * (seller: Malabar Weave Exports, buyer: Harbor & Pine Home; both fictional demo companies).
 */

const LIST = 16;
const FLOOR = 15.2;

type Ev = {
  who: 'buyer' | 'seller' | 'rule' | 'human' | 'paypal';
  text: string; stage: number; bad?: boolean; point?: RailPoint;
};
const WHO = { buyer: 'Buyer AI', seller: 'Seller AI', rule: 'Rules', human: 'Seller', paypal: 'PayPal' };
const STAGES = ['Enquiry', 'Read', 'Bargain', 'Approve', 'Paid'];

const EVENTS: Ev[] = [
  { who: 'buyer', stage: 0, text: '150 seagrass baskets, FOB, shipped in 30 days. Can you do $13.60 a unit?', point: { value: 13.6, kind: 'ask' } },
  { who: 'rule', stage: 1, bad: true, text: '$13.60 is below the minimum selling price. Blocked.', point: { value: 13.6, kind: 'blocked' } },
  { who: 'seller', stage: 2, text: 'We cannot meet $13.60. I can offer $15.60 with private-label tags.', point: { value: 15.6, kind: 'offer' } },
  { who: 'buyer', stage: 2, text: 'That is above our budget. Could you work with $14.20?', point: { value: 14.2, kind: 'ask' } },
  { who: 'rule', stage: 2, bad: true, text: '$14.20 exceeds the 5% discount cap. Blocked.', point: { value: 14.2, kind: 'blocked' } },
  { who: 'seller', stage: 2, text: '$14.20 is not possible. My best for 150 units is $15.30.', point: { value: 15.3, kind: 'offer' } },
  { who: 'rule', stage: 2, text: 'Buyer agent accepts. $15.30 is inside its own mandate.', point: { value: 15.3, kind: 'agreed' } },
  { who: 'human', stage: 3, text: 'Seller reviews a 46.41% margin and approves offer v2.' },
  { who: 'paypal', stage: 4, text: 'Seller agent sends the PayPal invoice: $688.50 advance.' },
  { who: 'paypal', stage: 4, text: 'PayPal confirms the payment. Balance invoice issued.' },
];

function pointsAt(step: number): RailPoint[] {
  const byValue = new Map<number, RailPoint>();
  for (const e of EVENTS.slice(0, step + 1)) if (e.point) byValue.set(e.point.value, e.point);
  return [...byValue.values()];
}

function Replay() {
  const reduced = useRef(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches).current;
  const last = EVENTS.length - 1;
  const [step, setStep] = useState(reduced ? last : 0);
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (reduced || step >= last) return;
    const t = setTimeout(() => setStep((s) => s + 1), 1750);
    return () => clearTimeout(t);
  }, [step, run, reduced, last]);

  const stage = EVENTS[step].stage;
  return (
    <div className="replay night" aria-label="Condensed replay of a recorded Sandbox deal">
      <div className="replay-head">
        <span className="eyebrow">Deal replay · <b>MW-BSK-01</b></span>
        <span className={`pill ${step >= last ? 'ok' : 'live'}`}>{step >= last ? 'Paid' : 'Live'}</span>
      </div>
      <div className="stages" aria-hidden="true">
        {STAGES.map((s, i) => <span key={s} className={i <= stage ? 'on' : ''}>{s}</span>)}
      </div>
      <PriceRail list={LIST} floor={FLOOR} points={pointsAt(step)} />
      <div className="feed" aria-live="off">
        {EVENTS.slice(0, step + 1).slice(-5).map((e) => (
          <div key={`${run}-${e.text}`} className={`feed-row ${e.who} ${e.bad ? 'bad' : ''}`}>
            <span className="who">{WHO[e.who]}</span><span>{e.text}</span>
          </div>
        ))}
      </div>
      <div className="replay-foot">
        <span>Condensed replay of a deal run on the PayPal Sandbox.</span>
        <button className="btn ghost sm" onClick={() => { setStep(0); setRun((r) => r + 1); }}>
          {step >= last ? 'Replay' : 'Restart'}
        </button>
      </div>
    </div>
  );
}

const DECIDES: [string, string][] = [
  ['What to say, what to ask, what to try next', 'AI agents'],
  ['Whether an offer is allowed, and every total, discount and margin', 'Code'],
  ['Whether the buyer agent may accept', 'Code'],
  ['Whether the deal goes ahead', 'The seller'],
  ['Whether the money has arrived', 'PayPal'],
];

const CHECKS = [
  'the model cannot quote below the minimum price',
  'the model cannot exceed the permitted discount',
  'buyer acceptance only queues the offer; approval is a separate human step',
  'a quote the seller has not approved cannot be invoiced',
  'an unverified webhook changes nothing and is not recorded',
  'a duplicate webhook does not issue another invoice',
  'the order is paid only when PayPal confirms both invoices',
  'withdrawing the quote cancels its unpaid PayPal invoice',
];

export function Landing() {
  useReveal();
  const col = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [stuck, setStuck] = useState(false);

  // The thread fills as the reader scrolls through the five stations.
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      setStuck(scrollY > 8);
      const el = col.current;
      if (!el) return;
      const line = innerHeight * 0.62;
      const rect = el.getBoundingClientRect();
      el.style.setProperty('--p', String(Math.min(1, Math.max(0, (line - rect.top) / rect.height))));
      let reached = 0;
      el.querySelectorAll('.station').forEach((s, i) => { if (s.getBoundingClientRect().top < line) reached = i + 1; });
      setActive(reached);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll);
    return () => { removeEventListener('scroll', onScroll); removeEventListener('resize', onScroll); cancelAnimationFrame(raf); };
  }, []);

  const on = (i: number) => (i < active ? 'station on' : 'station');

  return (
    <>
      <header className={`nav ${stuck ? 'stuck' : ''}`}>
        <div className="wrap">
          <Link to="/" aria-label="TradeThread home" style={{ textDecoration: 'none' }}><Logo /></Link>
          <nav className="nav-links" aria-label="Main">
            <a className="hide-sm" href="#journey">How it works</a>
            <a className="hide-sm" href="#rules">Guardrails</a>
            <a className="hide-sm" href={REPO} target="_blank" rel="noreferrer">GitHub</a>
            <Link to="/app" className="btn sm">Open the deal desk <Arrow /></Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="wrap hero-grid">
            <div>
              <p className="eyebrow rise" style={{ '--i': 0 } as React.CSSProperties}>AI export deal desk · <b>PayPal Sandbox</b></p>
              <h1 className="rise" style={{ '--i': 1 } as React.CSSProperties}>
                Every export deal hangs by a{' '}
                <span className="thread-word">thread.
                  <svg viewBox="0 0 300 30" preserveAspectRatio="none" aria-hidden="true"><path d="M4 18c40-16 70 14 110 2s70-16 100-4 60 8 82-6" /></svg>
                </span>
              </h1>
              <p className="lede rise" style={{ '--i': 2 } as React.CSSProperties}>
                TradeThread turns an overseas buyer's enquiry into a seller-approved offer and a paid PayPal invoice.
                An AI agent runs the negotiation. It cannot break your price rules, approve its own deal, or decide that money has arrived.
              </p>
              <div className="hero-cta rise" style={{ '--i': 3 } as React.CSSProperties}>
                <Link to="/app" className="btn thread lg">Open the deal desk <Arrow /></Link>
                <a href="#journey" className="btn ghost lg">See how a deal unfolds</a>
              </div>
              <div className="facts rise" style={{ '--i': 4 } as React.CSSProperties}>
                <span><b>2</b> agents, opposing mandates</span>
                <span><b>28</b> guardrail tests</span>
                <span>PayPal <b>Invoicing v2</b> + signed webhooks</span>
              </div>
            </div>
            <div className="rise" style={{ '--i': 3 } as React.CSSProperties}><Replay /></div>
          </div>
        </section>

        <section className="block" id="journey">
          <div className="wrap journey">
            <div className="sticky reveal">
              <p className="eyebrow">The journey</p>
              <h2 style={{ marginTop: 14 }}>From “how much?” to paid, in <em>five moves.</em></h2>
              <p className="intro">Follow one real deal: a US retailer wants 150 handwoven baskets from an exporter in Kochi, and wants them cheaper than the exporter can sell.</p>
            </div>

            <div className="thread-col" ref={col}>
              <div className="thread-line" /><div className="thread-fill" />

              <article className={on(0)}>
                <span className="node" /><p className="eyebrow"><b>01</b> · Enquiry</p>
                <h3>A buyer writes the way buyers write.</h3>
                <p>Loose, conversational, with a price in the middle of a sentence. No form to fill in.</p>
                <div className="visual card reveal">
                  <p className="quote">“We need <mark>150</mark> <mark>handwoven seagrass storage baskets</mark> for our retail stores. Can you meet <mark>$13.60 per unit</mark>, with <mark>private-label hang tags</mark>, shipped <mark>FOB within 30 days</mark>?”</p>
                  <p className="eyebrow" style={{ marginTop: 16 }}>Harbor &amp; Pine Home · United States · demo buyer</p>
                </div>
              </article>

              <article className={on(1)}>
                <span className="node" /><p className="eyebrow"><b>02</b> · Understanding</p>
                <h3>The agent finds the deal inside the message.</h3>
                <p>It pulls out what an offer needs. If something is missing it asks, at most two questions at a time.</p>
                <div className="visual card reveal">
                  <dl className="fields">
                    <div><dt>Product</dt><dd>MW-BSK-01 seagrass basket</dd></div>
                    <div><dt>Quantity</dt><dd className="num">150 units</dd></div>
                    <div><dt>Buyer's target</dt><dd className="num">$13.60</dd></div>
                    <div><dt>Ship within</dt><dd className="num">30 days</dd></div>
                    <div><dt>Shipping term</dt><dd>FOB</dd></div>
                    <div><dt>Must have</dt><dd>Private-label tags</dd></div>
                  </dl>
                </div>
              </article>

              <article className={on(2)}>
                <span className="node" /><p className="eyebrow"><b>03</b> · Negotiation</p>
                <h3>It bargains. Code holds the line.</h3>
                <p>Every price goes through a pricing engine before it can become an offer. In this deal two prices fell below the seller's floor and were refused, and the agent found the closest price that was allowed.</p>
                <div className="visual flush card reveal">
                  <PriceRail list={LIST} floor={FLOOR} points={pointsAt(EVENTS.length - 1)} />
                </div>
              </article>

              <article className={on(3)}>
                <span className="node" /><p className="eyebrow"><b>04</b> · Approval</p>
                <h3>A person says yes.</h3>
                <p>Neither agent has a tool that approves a deal. The seller sees the price, the discount and the margin, and decides.</p>
                <div className="visual card reveal">
                  <dl className="kv" style={{ marginTop: 0 }}>
                    <div><dt>Order</dt><dd>150 × seagrass basket</dd></div>
                    <div><dt>Unit price</dt><dd className="num">$15.30</dd></div>
                    <div><dt>Total</dt><dd className="num">$2,295.00</dd></div>
                    <div><dt>Discount</dt><dd className="num">4.38%</dd></div>
                    <div><dt>Seller's margin</dt><dd className="num">46.41%</dd></div>
                    <div><dt>Terms</dt><dd>FOB · 30 days</dd></div>
                  </dl>
                  <span className="stamp">Approved by the seller</span>
                </div>
              </article>

              <article className={on(4)}>
                <span className="node" /><p className="eyebrow"><b>05</b> · Payment</p>
                <h3>PayPal has the last word.</h3>
                <p>After approval the agent sends a PayPal invoice through a tool that carries no amounts. When PayPal confirms the advance, the balance invoice follows. An order is paid only when PayPal reports it paid.</p>
                <div className="visual card reveal">
                  <div className="scroll">
                    <table>
                      <thead><tr><th>PayPal invoice</th><th className="n">Amount</th><th>Status</th></tr></thead>
                      <tbody>
                        <tr><td>Advance · 30%</td><td className="n">$688.50</td><td><span className="pill ok">Paid</span></td></tr>
                        <tr><td>Balance</td><td className="n">$1,606.50</td><td><span className="pill ok">Paid</span></td></tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </article>
            </div>
          </div>
        </section>

        <section className="block night" id="rules">
          <div className="wrap">
            <p className="eyebrow reveal">Guardrails</p>
            <h2 className="reveal" style={{ marginTop: 14, maxWidth: '14em' }}>The AI negotiates. It never <em>decides.</em></h2>
            <div className="decide reveal">
              {DECIDES.map(([what, who]) => (
                <div className="decide-row" key={what}><p>{what}</p><span className="pill plain">{who}</span></div>
              ))}
            </div>
            <p className="eyebrow reveal" style={{ marginTop: 48 }}>Held by 28 automated tests, including</p>
            <ul className="checks reveal">{CHECKS.map((c) => <li key={c}>{c}</li>)}</ul>
          </div>
        </section>

        <section className="block">
          <div className="wrap">
            <p className="eyebrow reveal">Try it</p>
            <h2 className="reveal" style={{ marginTop: 14 }}>Open a deal and <em>pull the thread.</em></h2>
            <div className="doors">
              <Link to="/app?mode=agent" className="door card reveal">
                <div><p className="eyebrow">About a minute</p><h3 style={{ marginTop: 12 }}>Watch two AI agents negotiate.</h3></div>
                <div className="go"><span>Run an agent-to-agent deal</span><Arrow /></div>
              </Link>
              <Link to="/app?mode=human" className="door card reveal">
                <div><p className="eyebrow">Your move</p><h3 style={{ marginTop: 12 }}>Negotiate as the buyer yourself.</h3></div>
                <div className="go"><span>Send an enquiry</span><Arrow /></div>
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="wrap">
          <Logo />
          <p>A PayPal AI Hackathon project. Runs on the PayPal Sandbox with Google Gemini; no real money moves. Malabar Weave Exports and Harbor &amp; Pine Home are fictional demo companies.</p>
          <a href={REPO} target="_blank" rel="noreferrer">Source on GitHub · MIT</a>
        </div>
      </footer>
    </>
  );
}
