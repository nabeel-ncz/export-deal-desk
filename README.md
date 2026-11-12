# TradeThread · AI Export Deal Desk

An AI sales agent that turns an overseas buyer's enquiry into an approved, margin-safe offer and a paid PayPal invoice.

Built for the PayPal AI Hackathon ("Build what's next with PayPal and AI").

**Live demo:** https://export-deal-desk.onrender.com (the free instance sleeps when idle, so the first load can take about a minute).

## The problem

Small Indian exporters lose orders between "a buyer is interested" and "the buyer has paid". Enquiries arrive incomplete, buyers push for discounts, and a quote sent in a hurry can give away the margin. TradeThread handles that conversation for the seller without ever being allowed to break the seller's commercial rules.

## What it does

1. **A buyer arrives.** Either a buyer's own AI purchasing agent with a mandate (budget, quantity, delivery deadline), or a person typing in a chat.
2. **The seller agent negotiates.** It asks for missing details, tests counter-offers, and makes formal offers.
3. **Code enforces the rules.** Every offer passes through a deterministic pricing engine. Offers below the price floor or past the discount cap are blocked, and the block is shown on screen.
4. **The human seller approves.** The agents cannot approve a deal. The seller sees price, discount and margin and decides.
5. **The agent sends a PayPal invoice.** Only after approval does the seller agent get a tool to invoice, and the tool takes a note, never an amount.
6. **PayPal confirms payment.** The advance is paid, the balance invoice is issued automatically, and the order is marked paid only when PayPal itself reports each invoice as paid.

## Who decides what

| Decision | Made by |
| --- | --- |
| What to say, what to ask, what to try next | AI agents (Gemini) |
| Whether an offer is allowed; totals, discount, margin, advance | Deterministic code (`server/pricing.ts`) |
| Whether the buyer agent may accept | Deterministic check of the buyer's mandate |
| Whether the deal goes ahead | The human seller |
| Whether money has arrived | PayPal's API |

The binding numbers are the ones in the formal offer cards. The agents' chat text is free-form and is not validated.

## How PayPal is used

- **Invoicing API v2**: create, send, read and cancel invoices (`server/paypal.ts`).
- **Advance and balance as two invoices**: PayPal rejects partial payments on a single invoice for Indian merchant accounts, so the 30% advance and the balance are separate invoices, the second issued when the first is paid.
- **Webhooks**: on a public deployment the app registers its own webhook for `INVOICING.INVOICE.PAID` and verifies each event's signature with PayPal's verification API. Unverified events change nothing. Redelivered events are processed once.
- **PayPal is the source of truth**: a webhook only prompts the app to fetch the invoice's real status. A background sweep also checks unpaid invoices every 15 seconds, so a late webhook cannot leave an order stuck.
- **Withdrawing a quote** cancels its unpaid PayPal invoice.

Everything runs against the PayPal Sandbox. This project does not claim that live Indian merchant accounts have every invoicing feature enabled.

## How AI is used

- **Model**: Google Gemini (`gemini-3.5-flash`, falling back to its lite variants when overloaded or out of quota), called directly over its REST API with function calling (`server/llm.ts`). A free-tier key allows only about 20 requests per day per model and one negotiation uses 10 to 15, so use a key with billing enabled for anything beyond a single trial.
- **Seller agent** tools: `evaluate_terms`, `propose_offer`, and after approval `send_paypal_invoice`.
- **Buyer agent** tools: `accept_offer`, `walk_away`.
- **Development**: the code was written with Claude Code, Anthropic's AI coding assistant, directed and reviewed by the author.

## Run it locally

Requirements: Node.js 22 or later. No database install is needed; the app uses embedded Postgres (PGlite), or a real Postgres server if you set `DATABASE_URL`.

```bash
cp .env.example .env
```

Fill in `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` from a PayPal Sandbox REST app (developer.paypal.com → Apps & Credentials → Sandbox) and `GEMINI_API_KEY` from Google AI Studio. Then:

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Open http://localhost:3000. For development with hot reload, use `npm run dev` and open http://localhost:5173.

## Try the demo

The landing page (`/`) replays a recorded Sandbox deal and explains the flow. The working app is the seller workspace at `/app`: one shared deal workspace seen from the exporter's side, with the buyer played either by an AI purchasing agent or by you.

1. Open the seller workspace and click **Start negotiation** with **AI buyer + AI seller** selected. The two agents negotiate for about a minute. The conversation shows each price check, and the price protection panel plots every price that was asked for, blocked, offered or agreed against the seller's list price and lowest allowed price.
2. When the buyer agent accepts, click **Approve offer** in the approval panel, which shows the total, discount and margin.
3. The seller agent sends a Sandbox PayPal invoice for the advance. Click **Pay** next to it.
4. Pay with a PayPal Sandbox **personal** account. If your Sandbox merchant is Indian, the buyer account must be from another country (for example the United States), because PayPal India does not accept domestic payments.
5. Within about 15 seconds the advance shows as paid and a balance invoice appears. Pay it the same way and the deal reaches **Paid**.

You can also change the buyer agent's mandate before starting, or choose **I'll act as the buyer** to send an enquiry and negotiate as the buyer yourself.

All companies, people and products in the demo are fictional.

## Tests

```bash
npm test
```

28 tests cover the pricing boundaries and the guardrails, including: the model cannot quote below the minimum price or past the discount cap, an agent cannot approve its own offer, an unapproved quote cannot be invoiced, an unpaid or unverified payment cannot mark an order paid, and a duplicate webhook cannot issue a second invoice.

## Deploy

`render.yaml` is a Render blueprint for a single web service. Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `GEMINI_API_KEY` and `DATABASE_URL` in the Render dashboard. The PayPal webhook is registered automatically at startup using the service's public URL.

`DATABASE_URL` must point at a Postgres server, for example a free Neon project. The embedded PGlite database is for local runs only: it needs roughly 600 to 900 MB of memory, more than a small hosted instance provides. The schema and demo data are created automatically on first start.

## Limitations

- One product line per offer.
- A single demo seller with no login; the seller and buyer views share one deal page.
- Local runs with the embedded database need about 1 GB of free memory.
- A shared demo is limited to 30 new deals per hour to protect the AI key.

## Project layout

| Path | Purpose |
| --- | --- |
| `server/pricing.ts` | Commercial rules and money arithmetic, in integer cents |
| `server/agents.ts` | Seller and buyer agents and their tools |
| `server/threads.ts` | Deals, offers, acceptance and seller approval |
| `server/payments.ts` | Invoicing, payment confirmation, webhooks |
| `server/paypal.ts` | PayPal REST client |
| `server/llm.ts` | Gemini client with fallback and pacing |
| `server/schema.sql` | Database schema |
| `web/src/Landing.tsx` | Landing page with the replayed deal |
| `web/src/App.tsx` | Deal desk and deal pages |
| `web/src/ui.tsx` | Shared routing, branding and the price rail |
| `web/src/styles.css` | Design system |

## License

MIT. See [LICENSE](LICENSE).
