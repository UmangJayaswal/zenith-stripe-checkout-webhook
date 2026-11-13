# Stripe Checkout webhook starter

Job ID 0bamD7kYbtBsGd27yN2q

Use Node.js 22+ and the Stripe CLI for the authorized sandbox run.
The starter tools use Node built-ins and have no install step. Start
the listener and receiver in separate terminals from this folder:

    node listener.mjs
    node receiver.mjs

GET http://127.0.0.1:8787/health returns 200. The POST webhook route
returns 501 until you implement it. The local receiver accepts JSON at
http://127.0.0.1:8788/payment-events and prints each accepted event once
per receiver process. PORT and RECEIVER_PORT override the local ports.

## Implementation contract

- Read the untouched request bytes with a 1 MiB limit. Reject oversized
  bodies with 413. Verify the Stripe-Signature header with the official
  Stripe Node SDK and STRIPE_WEBHOOK_SECRET before parsing or processing
  the event. Keep the SDK's default timestamp tolerance. Missing,
  invalid or stale signatures return 400 with a generic error.
- Accept only test-mode checkout.session.completed events with
  payment_status paid. Acknowledge unrelated events and unpaid sessions
  with 200 and no forwarding. Use 400 for an eligible event with missing
  or invalid required fields. Reject live events in this exercise.
- POST only the following JSON to the fixed, trusted DESTINATION_URL
  from the environment. Use application/json and set Idempotency-Key
  to the event ID. Never take the destination from the incoming event.

      {
        "event_id": "evt_skillnexa_001",
        "event_type": "checkout.session.completed",
        "checkout_session_id": "cs_test_skillnexa_001",
        "amount_total_minor": 259900,
        "currency": "inr",
        "payment_status": "paid"
      }

  Map amount_total directly in minor units. Return 200 after a successful
  downstream 2xx. Use a short outbound timeout (about 2 seconds), do not
  follow redirects, and return 502 for failure so Stripe can retry.
  The mock receiver deduplicates by event ID in memory. Verify retry
  behavior with it. Document that a production receiver needs durable
  deduplication and that a durable queue can decouple slow forwarding.
- Use environment variables for secrets and endpoint configuration.
  Log only the normalized event or its ID and delivery outcome.
  Never log raw payloads, request signatures, secrets or customer data.
  Keep any Stripe SDK package manifest and lockfile in the repository.

## Local checks without a Stripe account

Set STRIPE_WEBHOOK_SECRET to a self-chosen local-only test value in both
the listener and test terminals. Set DESTINATION_URL for the listener to
the local receiver address above. Restart the listener after env changes.

    node send-fixture.mjs paid
    node send-fixture.mjs paid
    node send-fixture.mjs unpaid
    node send-fixture.mjs unrelated
    node send-fixture.mjs invalid
    node send-fixture.mjs stale

Expect 200 for the first four after implementation. Only the first paid
event should add a receiver log entry. Expect 400 for invalid and stale.
Also test missing signatures with Postman. Restart the receiver to clear
its in-memory records. Stop it to verify 502, then restart and resend.

## Postman collection

Create a POST request to http://127.0.0.1:8787/webhooks/stripe with
Content-Type application/json and Stripe-Signature set to a local
collection variable. Run the following in the test terminal:

    node send-fixture.mjs paid --body
    node send-fixture.mjs paid --print

Use postman-body.json as the binary request body to preserve exact bytes.
Set the signature variable locally from the printed header value and
send promptly. Add a second request with no signature and checks for
200 and 400 respectively. Export the collection with the signature
variable blank, and include instructions to regenerate it. Remove the
temporary postman-body.json from the repository if you created it.

## Stripe CLI sandbox verification

Use the official CLI links in RESOURCE_LINKS.txt. With authorized sandbox
access, sign in with stripe login. Then start forwarding:

    stripe listen --events checkout.session.completed --forward-to localhost:8787/webhooks/stripe

Restart the listener with the signing secret printed by this CLI session.
In a separate terminal, run:

    stripe trigger checkout.session.completed

Confirm the signed event is accepted and that a paid event yields the
expected JSON. Record a redacted result. If access is unavailable, report
the local simulation separately and mark the CLI test pending.

Use a real destination only after the reviewer supplies the approved
HTTPS URL, authentication requirements and payload contract. Test-mode
credentials and the Stripe CLI signing secret stay outside all submissions.
