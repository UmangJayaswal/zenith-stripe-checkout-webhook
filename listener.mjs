
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import process from 'node:process';
import Stripe from 'stripe';

// Load local environment variables when .env exists.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

// Server configuration.
const PORT = Number(process.env.PORT ?? 8787);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const DESTINATION_VALUE = process.env.DESTINATION_URL;

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
const OUTBOUND_TIMEOUT_MS = 2000;

// Stripe SDK requires an API-key argument when instantiated.
// This placeholder is never used for Stripe API requests.
// Webhook signature verification uses only the signing secret.
const stripe = new Stripe('api_key_placeholder');

// Validate the configured destination.
// Never accept a destination URL from the incoming event.
function getDestinationUrl() {
  if (!DESTINATION_VALUE) {
    return null;
  }

  try {
    const url = new URL(DESTINATION_VALUE);

    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

// Send a JSON response.
function sendJson(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
  });

  response.end(JSON.stringify(data));
}

// Read the original request bytes without parsing or modifying them.
// Reject bodies larger than 1 MiB.
async function readRawBody(request) {
  const chunks = [];
  let totalBytes = 0;
  let tooLarge = false;

  for await (const chunk of request) {
    totalBytes += chunk.length;

    if (totalBytes > MAX_BODY_BYTES) {
      tooLarge = true;
      continue;
    }

    chunks.push(chunk);
  }

  if (tooLarge) {
    const error = new Error('Payload too large');
    error.statusCode = 413;
    throw error;
  }

  return Buffer.concat(chunks);
}

// Validate the fields required by the forwarding contract.
function hasValidRequiredFields(event, session) {
  return (
    event.object === 'event' &&
    typeof event.id === 'string' &&
    /^evt_[A-Za-z0-9_]+$/.test(event.id) &&

    session.object === 'checkout.session' &&
    typeof session.id === 'string' &&
    /^cs_[A-Za-z0-9_]+$/.test(session.id) &&

    Number.isSafeInteger(session.amount_total) &&
    session.amount_total >= 0 &&

    typeof session.currency === 'string' &&
    /^[a-z]{3}$/.test(session.currency) &&

    session.payment_status === 'paid'
  );
}

// Main webhook processing function.
async function handleWebhook(request, response) {
  const destinationUrl = getDestinationUrl();

  // Check server configuration.
  if (!WEBHOOK_SECRET || !destinationUrl) {
    console.error('Webhook configuration is incomplete.');

    return sendJson(response, 500, {
      error: 'server_configuration_error',
    });
  }

  // STEP 1: Read the untouched request body.
  let rawBody;

  try {
    rawBody = await readRawBody(request);
  } catch (error) {
    if (error.statusCode === 413) {
      return sendJson(response, 413, {
        error: 'payload_too_large',
      });
    }

    return sendJson(response, 400, {
      error: 'invalid_request_body',
    });
  }

  // STEP 2: Verify Stripe signature and timestamp.
  let event;

  try {
    const signature = request.headers['stripe-signature'];

    if (typeof signature !== 'string' || !signature) {
      throw new Error('Missing Stripe signature');
    }

    // The original Buffer is passed directly to Stripe.
    // Default timestamp tolerance (300 seconds) is retained.
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      WEBHOOK_SECRET
    );
  } catch {
    // Do not expose signature details or secrets in responses.
    return sendJson(response, 400, {
      error: 'invalid_webhook_signature',
    });
  }

  // STEP 3: Validate the event structure.
  if (
    !event ||
    typeof event !== 'object' ||
    Array.isArray(event) ||
    event.object !== 'event'
  ) {
    return sendJson(response, 400, {
      error: 'invalid_event',
    });
  }

  // Only test-mode events are accepted.
  if (event.livemode !== false) {
    return sendJson(response, 400, {
      error: 'test_mode_events_only',
    });
  }

  // STEP 4: Ignore unrelated event types.
  if (event.type !== 'checkout.session.completed') {
    return sendJson(response, 200, {
      received: true,
      forwarded: false,
    });
  }

  const session = event.data?.object;

  if (
    !session ||
    typeof session !== 'object' ||
    Array.isArray(session) ||
    session.object !== 'checkout.session'
  ) {
    return sendJson(response, 400, {
      error: 'invalid_checkout_session',
    });
  }

  // STEP 5: Only paid Checkout sessions are forwarded.
  if (session.payment_status !== 'paid') {
    return sendJson(response, 200, {
      received: true,
      forwarded: false,
    });
  }

  // Validate the exact fields required by the receiver.
  if (!hasValidRequiredFields(event, session)) {
    return sendJson(response, 400, {
      error: 'invalid_checkout_session',
    });
  }

  // STEP 6: Normalize the Stripe event.
  const normalizedPayload = {
    event_id: event.id,
    event_type: event.type,
    checkout_session_id: session.id,
    amount_total_minor: session.amount_total,
    currency: session.currency,
    payment_status: session.payment_status,
  };

  // STEP 7: Forward the normalized JSON to the fixed destination.
  try {
    const downstreamResponse = await fetch(destinationUrl, {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': event.id,
      },

      body: JSON.stringify(normalizedPayload),

      // Stop waiting after two seconds.
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),

      // Do not follow redirects to another destination.
      redirect: 'manual',
    });

    // Any non-2xx response is treated as a delivery failure.
    if (!downstreamResponse.ok) {
      console.error(JSON.stringify({
        event_id: event.id,
        delivery: 'failed',
        status: downstreamResponse.status,
      }));

      return sendJson(response, 502, {
        error: 'downstream_delivery_failed',
      });
    }

    // Log only the event ID and delivery outcome.
    console.log(JSON.stringify({
      event_id: event.id,
      delivery: 'succeeded',
    }));

    return sendJson(response, 200, {
      received: true,
      forwarded: true,
    });

  } catch {
    // Stripe can retry because we return HTTP 502.
    console.error(JSON.stringify({
      event_id: event.id,
      delivery: 'failed',
      reason: 'timeout_or_network_error',
    }));

    return sendJson(response, 502, {
      error: 'downstream_delivery_failed',
    });
  }
}

// Create the HTTP server.
createServer(async (request, response) => {
  // Health endpoint.
  if (
    request.method === 'GET' &&
    request.url === '/health'
  ) {
    response.writeHead(200, {
      'Content-Type': 'text/plain',
    });

    response.end('ok');
    return;
  }

  // Webhook endpoint.
  if (
    request.method !== 'POST' ||
    request.url !== '/webhooks/stripe'
  ) {
    response.writeHead(404).end();
    return;
  }

  try {
    await handleWebhook(request, response);
  } catch {
    console.error('Unexpected webhook processing error.');

    if (!response.headersSent) {
      sendJson(response, 500, {
        error: 'internal_server_error',
      });
    }
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(
    `Stripe webhook listener running on 127.0.0.1:${PORT}`
  );
});
