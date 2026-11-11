import { useEffect, useState } from 'react';

interface Health { ok: boolean; database: string; products: number; paypalConfigured: boolean; geminiConfigured: boolean }
interface Seller {
  name: string; city: string; country: string;
  max_discount_pct: string; deposit_pct: string; accepted_incoterms: string[]; approval_required: boolean;
}
interface Product {
  id: number; sku: string; name: string;
  unit_cost: string; list_price: string; min_price: string; moq: number; capacity_units: number; lead_time_days: number;
}

const usd = (v: string | number) => `$${Number(v).toFixed(2)}`;

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [data, setData] = useState<{ seller: Seller; products: Product[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetch('/api/health'), fetch('/api/seller')])
      .then(async ([h, s]) => {
        if (!h.ok || !s.ok) throw new Error(`API returned ${h.status} / ${s.status}`);
        setHealth(await h.json());
        setData(await s.json());
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <main><h1>Export Deal Desk</h1><p className="chip bad">Cannot reach the API: {error}</p></main>;
  if (!health || !data) return <main><h1>Export Deal Desk</h1><p className="muted">Loading…</p></main>;

  const { seller, products } = data;
  return (
    <main>
      <h1>Export Deal Desk</h1>
      <p className="muted">{seller.name} · {seller.city}, {seller.country}</p>

      <section className="card">
        <h2>System</h2>
        <div className="chips">
          <span className="chip ok">Database: {health.database}</span>
          <span className={`chip ${health.paypalConfigured ? 'ok' : 'bad'}`}>PayPal Sandbox {health.paypalConfigured ? 'configured' : 'missing keys'}</span>
          <span className={`chip ${health.geminiConfigured ? 'ok' : 'bad'}`}>Gemini {health.geminiConfigured ? 'configured' : 'missing key'}</span>
        </div>
      </section>

      <section className="card">
        <h2>Commercial rules the agent cannot break</h2>
        <div className="chips">
          <span className="chip">Max discount {Number(seller.max_discount_pct)}%</span>
          <span className="chip">Advance {Number(seller.deposit_pct)}%</span>
          <span className="chip">Shipping terms {seller.accepted_incoterms.join(' / ')}</span>
          <span className="chip">{seller.approval_required ? 'Seller approval required' : 'Auto-approve'}</span>
        </div>
      </section>

      <section className="card">
        <h2>Catalogue</h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>SKU</th><th>Product</th>
                <th className="num">Cost</th><th className="num">List</th><th className="num">Floor</th>
                <th className="num">Min order</th><th className="num">Capacity</th><th className="num">Lead time</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id}>
                  <td>{p.sku}</td><td>{p.name}</td>
                  <td className="num">{usd(p.unit_cost)}</td><td className="num">{usd(p.list_price)}</td><td className="num">{usd(p.min_price)}</td>
                  <td className="num">{p.moq}</td><td className="num">{p.capacity_units}</td><td className="num">{p.lead_time_days} days</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
