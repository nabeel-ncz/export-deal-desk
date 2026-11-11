-- Export Deal Desk schema. Idempotent: safe to run on every boot.
-- Money is USD NUMERIC(12,2); percentages are NUMERIC(5,2) (5.00 = 5%).

CREATE TABLE IF NOT EXISTS sellers (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  city              TEXT NOT NULL,
  country           TEXT NOT NULL,
  email             TEXT NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'USD',
  max_discount_pct  NUMERIC(5,2) NOT NULL,
  deposit_pct       NUMERIC(5,2) NOT NULL DEFAULT 0,
  accepted_incoterms TEXT[] NOT NULL,
  approval_required BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id              SERIAL PRIMARY KEY,
  seller_id       INTEGER NOT NULL REFERENCES sellers(id),
  sku             TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  unit_cost       NUMERIC(12,2) NOT NULL,
  list_price      NUMERIC(12,2) NOT NULL,
  min_price       NUMERIC(12,2) NOT NULL,
  moq             INTEGER NOT NULL,
  capacity_units  INTEGER NOT NULL,
  lead_time_days  INTEGER NOT NULL,
  CHECK (unit_cost < min_price AND min_price <= list_price)
);

CREATE TABLE IF NOT EXISTS buyer_threads (
  id             SERIAL PRIMARY KEY,
  seller_id      INTEGER NOT NULL REFERENCES sellers(id),
  buyer_name     TEXT NOT NULL,
  buyer_company  TEXT,
  buyer_country  TEXT,
  mode           TEXT NOT NULL CHECK (mode IN ('human', 'agent')),
  buyer_mandate  JSONB,
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'awaiting_approval', 'invoiced', 'paid', 'closed')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id          SERIAL PRIMARY KEY,
  thread_id   INTEGER NOT NULL REFERENCES buyer_threads(id),
  role        TEXT NOT NULL CHECK (role IN ('buyer', 'buyer_agent', 'seller_agent', 'seller', 'system')),
  content     TEXT NOT NULL,
  tool_trace  JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quote_drafts (
  id            SERIAL PRIMARY KEY,
  thread_id     INTEGER NOT NULL REFERENCES buyer_threads(id),
  version       INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'superseded', 'invoiced', 'paid')),
  incoterm      TEXT NOT NULL,
  discount_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,
  subtotal      NUMERIC(12,2) NOT NULL,
  total         NUMERIC(12,2) NOT NULL,
  margin_pct    NUMERIC(5,2) NOT NULL,
  deposit_pct   NUMERIC(5,2) NOT NULL DEFAULT 0,
  delivery_days INTEGER NOT NULL,
  terms         JSONB,
  approved_by   TEXT,
  approved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (thread_id, version)
);

CREATE TABLE IF NOT EXISTS quote_items (
  id          SERIAL PRIMARY KEY,
  quote_id    INTEGER NOT NULL REFERENCES quote_drafts(id),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  unit_price  NUMERIC(12,2) NOT NULL,
  line_total  NUMERIC(12,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS paypal_invoices (
  id                 SERIAL PRIMARY KEY,
  quote_id           INTEGER NOT NULL REFERENCES quote_drafts(id),
  paypal_invoice_id  TEXT NOT NULL UNIQUE,
  kind               TEXT NOT NULL CHECK (kind IN ('full', 'deposit', 'balance')),
  amount             NUMERIC(12,2) NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'USD',
  status             TEXT NOT NULL,
  pay_url            TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- paypal_event_id is UNIQUE so a redelivered webhook cannot be recorded twice.
CREATE TABLE IF NOT EXISTS payment_events (
  id                 SERIAL PRIMARY KEY,
  paypal_event_id    TEXT NOT NULL UNIQUE,
  event_type         TEXT NOT NULL,
  paypal_invoice_id  TEXT,
  verified           BOOLEAN NOT NULL,
  payload            JSONB NOT NULL,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          SERIAL PRIMARY KEY,
  thread_id   INTEGER REFERENCES buyer_threads(id),
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
