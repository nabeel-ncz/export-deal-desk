/**
 * PayPal REST client for the Invoicing v2 API and webhook signature verification.
 * Defaults to the Sandbox. payments.ts depends only on the PayPal interface, so tests use a fake.
 */

export interface InvoiceRequest {
  reference: string; note: string; itemName: string; quantity: number; unitAmount: number; currency?: string;
}

export interface PayPal {
  createAndSendInvoice(req: InvoiceRequest): Promise<{ id: string; status: string; payUrl: string | null }>;
  getInvoice(id: string): Promise<{ id: string; status: string; paidAmount: number }>;
  cancelInvoice(id: string): Promise<void>;
  /** True only when PayPal itself confirms the webhook signature. */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<boolean>;
}

export function paypalClient(env: NodeJS.ProcessEnv = process.env): PayPal & { ensureWebhook(url: string): Promise<string> } {
  const base = env.PAYPAL_API_BASE ?? 'https://api-m.sandbox.paypal.com';
  let webhookId = env.PAYPAL_WEBHOOK_ID;
  let token: { value: string; expires: number } | null = null;

  const accessToken = async () => {
    if (token && token.expires > Date.now() + 60_000) return token.value;
    if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) throw new Error('PayPal credentials are not set');
    const res = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`PayPal sign-in failed (${res.status}): ${json.error_description ?? json.error ?? ''}`);
    token = { value: json.access_token, expires: Date.now() + json.expires_in * 1000 };
    return token.value;
  };

  const call = async (path: string, method = 'GET', body?: string): Promise<any> => {
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const detail = json.details?.map((d: any) => d.description ?? d.issue).join('; ') ?? json.message ?? '';
      throw new Error(`PayPal ${method} ${path.split('?')[0]} failed (${res.status}): ${detail}`);
    }
    return json;
  };

  const header = (headers: Record<string, string | string[] | undefined>, name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };

  return {
    async createAndSendInvoice(req) {
      const currency = req.currency ?? 'USD';
      const draft = await call('/v2/invoicing/invoices', 'POST', JSON.stringify({
        detail: { currency_code: currency, reference: req.reference, note: req.note, payment_term: { term_type: 'DUE_ON_RECEIPT' } },
        items: [{
          name: req.itemName.slice(0, 200), quantity: String(req.quantity),
          unit_amount: { currency_code: currency, value: req.unitAmount.toFixed(2) },
        }],
      }));
      const id: string = draft.id ?? String(draft.href).split('/').pop();
      // The buyer pays through the shareable link, so PayPal does not need to email anyone.
      await call(`/v2/invoicing/invoices/${id}/send`, 'POST', JSON.stringify({ send_to_invoicer: false, send_to_recipient: false }));
      const inv = await call(`/v2/invoicing/invoices/${id}`);
      return { id, status: inv.status, payUrl: inv.detail?.metadata?.recipient_view_url ?? null };
    },

    async getInvoice(id) {
      const inv = await call(`/v2/invoicing/invoices/${id}`);
      return { id, status: inv.status, paidAmount: Number(inv.payments?.paid_amount?.value ?? 0) };
    },

    async cancelInvoice(id) {
      await call(`/v2/invoicing/invoices/${id}/cancel`, 'POST', JSON.stringify({ send_to_invoicer: false, send_to_recipient: false }));
    },

    async verifyWebhook(headers, rawBody) {
      const fields = {
        auth_algo: header(headers, 'paypal-auth-algo'),
        cert_url: header(headers, 'paypal-cert-url'),
        transmission_id: header(headers, 'paypal-transmission-id'),
        transmission_sig: header(headers, 'paypal-transmission-sig'),
        transmission_time: header(headers, 'paypal-transmission-time'),
        webhook_id: webhookId,
      };
      if (!webhookId || Object.values(fields).some((v) => !v)) return false;
      // The event must be sent back byte-for-byte, so the raw body is spliced in rather than re-serialised.
      const body = `${JSON.stringify(fields).slice(0, -1)},"webhook_event":${rawBody}}`;
      const result = await call('/v1/notifications/verify-webhook-signature', 'POST', body);
      return result.verification_status === 'SUCCESS';
    },

    /** Register this deployment's webhook URL with PayPal, or reuse the existing registration for it. */
    async ensureWebhook(url) {
      if (webhookId) return webhookId;
      const list = await call('/v1/notifications/webhooks');
      const existing = list.webhooks?.find((w: any) => w.url === url);
      const hook = existing ?? await call('/v1/notifications/webhooks', 'POST', JSON.stringify({
        url, event_types: [{ name: 'INVOICING.INVOICE.PAID' }, { name: 'INVOICING.INVOICE.CANCELLED' }],
      }));
      webhookId = hook.id as string;
      return webhookId;
    },
  };
}
