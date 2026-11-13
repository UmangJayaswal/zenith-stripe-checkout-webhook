import { readFile, writeFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';

const scenario = process.argv[2] ?? 'paid';
const variants = ['paid', 'unpaid', 'unrelated', 'invalid', 'stale'];
if (!variants.includes(scenario)) throw new Error('Use ' + variants.join(', '));

const secret = process.env.STRIPE_WEBHOOK_SECRET;
if (!secret) throw new Error('Set STRIPE_WEBHOOK_SECRET to a local test-only value.');

const raw = await readFile(new URL('./fixtures/checkout_completed.json', import.meta.url), 'utf8');
const event = JSON.parse(raw);
if (scenario === 'unpaid') {
  event.id += '_unpaid';
  event.data.object.payment_status = 'unpaid';
}
if (scenario === 'unrelated') {
  event.id += '_unrelated';
  event.type = 'checkout.session.expired';
}
const body = JSON.stringify(event);
const timestamp = Math.floor(Date.now() / 1000) - (scenario === 'stale' ? 900 : 0);
const digest = createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
const signature = 't=' + timestamp + ',v1=' + (scenario === 'invalid' ? '0'.repeat(64) : digest);

if (process.argv.includes('--body')) {
  await writeFile('postman-body.json', body, { flag: 'w' });
} else if (process.argv.includes('--print')) {
  console.log(JSON.stringify({ 'Stripe-Signature': signature, body }, null, 2));
} else {
  const port = Number(process.env.PORT ?? 8787);
  const result = await fetch('http://127.0.0.1:' + port + '/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
    body,
    signal: AbortSignal.timeout(4000),
  });
  console.log('HTTP ' + result.status, await result.text());
}
