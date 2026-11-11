// Spike: prove PayPal Sandbox invoicing works end to end for this account.
// Run: node --env-file=.env spike/paypal-invoice.mjs            (create + send)
//      node --env-file=.env spike/paypal-invoice.mjs <invoiceId> (check status)
const BASE = 'https://api-m.sandbox.paypal.com';
const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;

async function call(path, { method = 'GET', token, body, form } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: token
        ? `Bearer ${token}`
        : 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
    },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    console.error(`FAILED ${method} ${path} -> ${res.status}`);
    console.error(JSON.stringify(json, null, 2));
    process.exit(1);
  }
  return json;
}

const auth = await call('/v1/oauth2/token', { method: 'POST', form: 'grant_type=client_credentials' });
const token = auth.access_token;
console.log('1. token OK | scopes include invoicing:', /invoicing/.test(auth.scope ?? ''));

const existing = process.argv[2];
if (existing) {
  const inv = await call(`/v2/invoicing/invoices/${existing}`, { token });
  console.log('status:', inv.status, '| due:', inv.due_amount?.value, '| paid:', inv.payments?.paid_amount?.value ?? '0');
  process.exit(0);
}

const draft = await call('/v2/invoicing/invoices', {
  method: 'POST',
  token,
  body: {
    detail: {
      currency_code: 'USD',
      reference: 'SPIKE-' + Date.now(),
      note: 'Deal Desk spike: 150 handwoven storage baskets',
      payment_term: { term_type: 'NET_10' },
    },
    items: [{ name: 'Handwoven storage basket', quantity: '150', unit_amount: { currency_code: 'USD', value: '14.50' } }],
    // Finding: partial_payment is rejected for this (Indian) merchant account:
    // "Partial payments are not available in your country." Deposits need two invoices.
  },
});
const invoiceId = draft.id ?? draft.href?.split('/').pop();
console.log('2. draft created:', invoiceId);

const sent = await call(`/v2/invoicing/invoices/${invoiceId}/send`, {
  method: 'POST',
  token,
  body: { send_to_invoicer: false, send_to_recipient: false },
});
console.log('3. send response:', JSON.stringify(sent));

const inv = await call(`/v2/invoicing/invoices/${invoiceId}`, { token });
console.log('4. status:', inv.status, '| total:', inv.amount?.value, inv.amount?.currency_code);
console.log('   invoicer:', inv.invoicer?.email_address ?? '(account default)');
console.log('   buyer pay link:', inv.detail?.metadata?.recipient_view_url);
