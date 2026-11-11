import type { Db } from './db.ts';

/** Fictional demo exporter and catalogue. Inserts only when the database is empty. */
export async function seed(db: Db): Promise<boolean> {
  const [{ n }] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM sellers');
  if (n > 0) return false;

  const [seller] = await db.query<{ id: number }>(
    `INSERT INTO sellers (name, city, country, email, max_discount_pct, deposit_pct, accepted_incoterms)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    ['Malabar Weave Exports', 'Kochi', 'India', 'sales@malabarweave.example', 5, 30, ['FOB', 'CIF']],
  );

  const products = [
    ['MW-BSK-01', 'Handwoven seagrass storage basket',
      'Natural seagrass, 30 cm, woven by artisan cooperatives in Kerala. Private-label tags available.',
      8.2, 16.0, 14.0, 100, 500, 21],
    ['MW-RUN-02', 'Jute and cotton table runner',
      'Hand-loomed jute and cotton blend, 180 x 35 cm, natural dyes.',
      4.1, 9.5, 8.0, 150, 1200, 18],
    ['MW-TRY-03', 'Mango wood serving tray with brass inlay',
      'Solid mango wood, 40 x 28 cm, hand-set brass inlay, food-safe finish.',
      11.75, 24.0, 21.0, 60, 300, 28],
  ] as const;

  for (const p of products) {
    await db.query(
      `INSERT INTO products
         (seller_id, sku, name, description, unit_cost, list_price, min_price, moq, capacity_units, lead_time_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [seller.id, ...p],
    );
  }
  return true;
}
