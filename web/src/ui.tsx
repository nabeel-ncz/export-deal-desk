import { useEffect, useState, type AnchorHTMLAttributes } from 'react';

/** Shared brand, routing and visual components used by both the landing page and the deal desk. */

export const BRAND = 'TradeThread';
export const TAGLINE = 'AI Export Deal Desk';
export const REPO = 'https://github.com/nabeel-ncz/export-deal-desk';

export const usd = (v: string | number) =>
  `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json as T;
}

/* Routing: three paths, so the History API is enough. The server already serves index.html for any non-API path. */
export function navigate(to: string) {
  history.pushState({}, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
  if (!to.includes('#')) scrollTo(0, 0);
}

export function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const sync = () => setPath(location.pathname);
    addEventListener('popstate', sync);
    return () => removeEventListener('popstate', sync);
  }, []);
  return path;
}

export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      {...rest}
      href={to}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}

export function Logo() {
  return (
    <span className="logo">
      <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
        <path d="M5 23c4-15 8-15 11-7s7 8 11-7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
        <circle cx="5" cy="23" r="3.2" />
        <circle cx="27" cy="9" r="3.2" className="knot" />
      </svg>
      <span>Trade<i>Thread</i></span>
    </span>
  );
}

export const Arrow = () => <span className="arrow" aria-hidden="true">→</span>;

/** Fade elements with the .reveal class in as they scroll into view. */
export function useReveal() {
  useEffect(() => {
    const els = [...document.querySelectorAll<HTMLElement>('.reveal:not(.in)')];
    if (!('IntersectionObserver' in window)) return els.forEach((el) => el.classList.add('in'));
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      }
    }, { threshold: 0.12 });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

export interface RailPoint { value: number; kind: 'ask' | 'blocked' | 'offer' | 'agreed' }
const KIND = { ask: 'Buyer asks', blocked: 'Blocked', offer: 'Offer', agreed: 'Agreed' };

/**
 * The price rail plots a negotiation on one line: the seller's list price, the lowest price the rules allow,
 * and every price that was asked for, blocked, offered or agreed.
 */
export function PriceRail({ list, floor, points }: { list: number; floor: number; points: RailPoint[] }) {
  const values = [list, floor, ...points.map((p) => p.value)];
  const lo = Math.min(...values), hi = Math.max(...values);
  const pad = Math.max((hi - lo) * 0.1, 0.15);
  const pos = (v: number) => `${((v - (lo - pad)) / (hi - lo + pad * 2)) * 100}%`;
  // Neighbouring prices get alternating label heights so their labels do not collide.
  const rankByValue = new Map([...points].sort((a, b) => a.value - b.value).map((p, i) => [p.value, i]));
  const summary = points.map((p) => `${KIND[p.kind]} ${usd(p.value)}`).join(', ');
  return (
    <div className="rail" role="img" aria-label={`Price rail. List price ${usd(list)}. Lowest allowed ${usd(floor)}. ${summary}`}>
      <div className="rail-track">
        <div className="rail-blocked" style={{ width: pos(floor) }} />
        <div className="rail-tick" style={{ left: pos(floor) }}><span>Lowest allowed<b>{usd(floor)}</b></span></div>
        <div className="rail-tick" style={{ left: pos(list) }}><span>List<b>{usd(list)}</b></span></div>
        {points.map((p) => (
          <div key={`${p.kind}-${p.value}`} className={`rail-pt ${p.kind} ${(rankByValue.get(p.value) ?? 0) % 2 ? 'high' : ''}`} style={{ left: pos(p.value) }}>
            <i /><span>{KIND[p.kind]}<b>{usd(p.value)}</b></span>
          </div>
        ))}
      </div>
      <div className="rail-note">No-offer zone: below the seller's floor</div>
    </div>
  );
}
