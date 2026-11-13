import { createServer } from 'node:http';

const port = Number(process.env.RECEIVER_PORT ?? 8788);
const seen = new Set();
const fields = ['event_id', 'event_type', 'checkout_session_id',
  'amount_total_minor', 'currency', 'payment_status'];

createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/payment-events') {
    response.writeHead(404).end();
    return;
  }

  const parts = [];
  let length = 0;
  try {
    for await (const part of request) {
      length += part.length;
      if (length > 8192) {
        response.writeHead(413).end();
        return;
      }
      parts.push(part);
    }
    const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
    const key = request.headers['idempotency-key'];
    if (!value || Array.isArray(value) || typeof value !== 'object' ||
        Object.keys(value).length !== fields.length ||
        !fields.every(field => Object.hasOwn(value, field)) ||
        request.headers['content-type']?.split(';')[0] !== 'application/json' ||
        typeof value.event_id !== 'string' || !/^evt_[A-Za-z0-9_]+$/.test(value.event_id) ||
        typeof value.checkout_session_id !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(value.checkout_session_id) ||
        !Number.isSafeInteger(value.amount_total_minor) || value.amount_total_minor < 0 ||
        typeof value.currency !== 'string' || !/^[a-z]{3}$/.test(value.currency) ||
        value.event_type !== 'checkout.session.completed' ||
        value.payment_status !== 'paid' || key !== value.event_id) {
      response.writeHead(422).end('Invalid forwarding payload or idempotency key');
      return;
    }
    if (!seen.has(key)) {
      seen.add(key);
      console.log(JSON.stringify(value));
    }
    response.writeHead(204).end();
  } catch {
    response.writeHead(400).end('Invalid JSON');
  }
}).listen(port, '127.0.0.1', () => {
  console.log('Local receiver is running on 127.0.0.1:' + port);
});
