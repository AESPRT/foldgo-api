# Fold&Go API Documentation

This document explains how to use the Fold&Go API (local developer edition). The server mounts two main route groups:
- `/v1/laundry` — system and shop management endpoints
- `/v1/payments` — payment checkout and webhook endpoints

Base URL

- Local development: `http://localhost:3000`
- Example production mount: `https://api.fold-go.example.com`

Environment Variables

- `DATABASE_URL` or DB connection used by `src/config/database.js` (required)
- `PAYMONGO_SECRET_KEY` — PayMongo API secret for creating checkout sessions
- `PAYMONGO_WH_SECRET` — webhook signing secret for validating PayMongo webhooks
- `EMAIL_USER`, `EMAIL_PASS` (or `MAIL_USER`, `MAIL_PASS`) — SMTP creds for outgoing emails
- `JWT_SECRET` — operator JWT signing secret
- `SHOP_JWT_SECRET` — shop JWT signing secret
- `PORT` — optional server port

Notes about PayMongo webhook raw body

The server captures raw request body for the PayMongo webhook route `/v1/payments/paymongo-webhook` (see `server.js`), this is required to verify the signature provided in the `paymongo-signature` header.

Security and Auth

- Operator auth: `POST /v1/laundry/login` returns a JWT (signed by `JWT_SECRET`) used for operator-only operations.
- Shop auth: `POST /v1/laundry/shops/login` returns a shop JWT (signed by `SHOP_JWT_SECRET`) used to authenticate shop-scoped operations (e.g., `GET /v1/laundry/shops/sync`, `POST /v1/laundry/shops/upsert`).
- For shop endpoints you can either pass `shopId` in the query/body or include a Bearer token: `Authorization: Bearer <shop-jwt>`.

Database notes

- `fold_go_operators` now uses `operator_id` (VARCHAR PK) and `email` is `UNIQUE NOT NULL`.
- `shops.owner_id` references `fold_go_operators(operator_id)`.
- Several tables use JSONB fields (`shops.settings`, `orders.items_json`, `orders.intake_photos_json`, `sync_outbox.payload_json`).

Routes and Usage

1) Payment: Create Checkout Session

- URL: `POST /v1/payments/checkout`
- Purpose: Create a PayMongo checkout session for SAAS or SMS bundles.
- Content-Type: `application/json`

Request Body (SAAS example)

{
  "userId": "user-123",
  "packageId": "plan-basic",
  "type": "SAAS",
  "cycle": "MONTHLY",
  "cusEmail": "owner@example.com",
  "cusName": "Owner Name",
  "cusPhone": "09171234567",
  "successUrl": "https://merchant.example.com/success",
  "cancelUrl": "https://merchant.example.com/cancel"
}

Response

- `200` JSON: `{ checkoutUrl: "https://...", referenceNumber: "TXN-SUB-..." }`

cURL Example

```bash
curl -X POST http://localhost:3000/v1/payments/checkout \
  -H "Content-Type: application/json" \
  -d '{"type":"SAAS","packageId":"plan-basic","cusEmail":"owner@example.com"}'
```

Sample Request Body (SAAS) - JSON (copy into Postman raw body)

{
  "userId": "user-123",
  "packageId": "plan-basic",
  "type": "SAAS",
  "cycle": "MONTHLY",
  "cusEmail": "owner@example.com",
  "cusName": "Owner Name",
  "cusPhone": "09171234567",
  "successUrl": "https://merchant.example.com/success",
  "cancelUrl": "https://merchant.example.com/cancel"
}

Sample Response (200)

{
  "checkoutUrl": "https://checkout.paymongo.com/session/abcd1234",
  "referenceNumber": "TXN-SUB-1678901234567"
}

2) Payment: PayMongo Webhook (fulfillment)

- URL: `POST /v1/payments/paymongo-webhook`
- PayMongo will POST events here. The server validates the `paymongo-signature` header using `PAYMONGO_WH_SECRET`.
- On `checkout_session.payment.paid` the system:
  - Marks related `fold_and_go_transactions.payment_status` as `SUCCESS`.
  - For SAAS purchases: inserts/updates `fold_go_operators` (now including `operator_id`) and sends administrative email asynchronously.

Important: Keep `PAYMONGO_WH_SECRET` secret. The server expects the signature header format `t=<timestamp>,v1=<hex>` (as produced by PayMongo) and compares HMAC-SHA256.

Sample Webhook Headers (Postman - set under Headers)

Key: `paymongo-signature`
Value: `t=1620000000,v1=abcdef1234567890...`

Sample Webhook Body (checkout_session.payment.paid) - simplified

{
  "data": {
    "attributes": {
      "type": "checkout_session.payment.paid",
      "data": {
        "attributes": {
          "reference_number": "TXN-SUB-1678901234567",
          "metadata": { "type": "SAAS", "package_id": "plan-basic", "billing_cycle": "MONTHLY", "customer_email": "owner@example.com" },
          "billing": { "email": "owner@example.com", "name": "Owner Name", "phone": "09171234567" }
        }
      }
    }
  }
}

Sample Webhook Response (200)

{
  "status": "fulfilled"
}

3) Payment: Verify Dashboard Token (admin)

- URL: `GET /v1/payments/verify-dashboard?referenceNumber=TXN-SUB-...`
- Returns dashboard URL, username (email), plan id, and `secureApkToken` if payment is successful.

4) Operator Login

- URL: `POST /v1/laundry/login`
- Body: `{ "email": "...", "password": "..." }`
- Response: `{ token: "...", operator: { id, referenceNumber, email, planId, ... } }`
- Use this token for operator-protected API calls.

Sample Request (Operator Login)

POST /v1/laundry/login
Content-Type: application/json

{
  "email": "ops@example.com",
  "password": "SecretP@ssw0rd"
}

Sample Response (200)

{
  "message": "Login successful",
  "token": "eyJhbGci...",
  "operator": {
    "id": "ops@example.com",
    "referenceNumber": "TXN-SUB-...",
    "name": "Operations",
    "email": "ops@example.com",
    "planId": "plan-basic",
    "billingCycle": "MONTHLY",
    "smsCreditBalance": 0
  }
}

5) Create Shop (operator)

- URL: `POST /v1/laundry/shops`
- Body (JSON):
  - `name` (required)
  - `ownerId` (required) — must be an existing `operator_id` from `fold_go_operators`
  - `shopId` (optional) — will be generated if omitted
  - `address`, `mobileNumber`, `pin`, `settings` (optional)

Response: `201` with created shop object.

cURL Example

```bash
curl -X POST http://localhost:3000/v1/laundry/shops \
  -H "Content-Type: application/json" \
  -d '{"name":"Main Branch","ownerId":"OP-abc123","pin":"1234"}'
```

Sample Request (Create Shop)

POST /v1/laundry/shops
Content-Type: application/json

{
  "name": "Main Branch",
  "ownerId": "OP-abc123",
  "address": "123 Laundry St",
  "mobileNumber": "09171234567",
  "pin": "1234",
  "settings": { "currency": "PHP", "tax": 0.12 }
}

Sample Response (201)

{
  "shopId": "SHOP-1a2b3c",
  "name": "Main Branch",
  "address": "123 Laundry St",
  "mobileNumber": "09171234567",
  "ownerId": "OP-abc123",
  "pin": "1234",
  "settings": { "currency": "PHP", "tax": 0.12 }
}

6) Shop Login

- URL: `POST /v1/laundry/shops/login`
- Body: `{ "shopId": "SHOP-...", "pin": "1234" }`
- Response: `{ token: "<shop-jwt>", shop: { id, name, ownerId } }`

Use `Authorization: Bearer <shop-jwt>` for shop-protected endpoints.

Sample Request (Shop Login)

POST /v1/laundry/shops/login
Content-Type: application/json

{
  "shopId": "SHOP-1a2b3c",
  "pin": "1234"
}

Sample Response (200)

{
  "message": "Login successful",
  "token": "eyJhbGci...",
  "shop": { "id": "SHOP-1a2b3c", "name": "Main Branch", "ownerId": "OP-abc123" }
}

7) Sync by Shop

- URL: `GET /v1/laundry/shops/sync?shopId=SHOP-...` or send Bearer token
- Returns an object with:
  - `shop`, `staff[]`, `machines[]`, `services[]`, `smsSubscriptions[]`, `orders[]`, `orderBatches[]`, `customers[]`, `smsTransactionLogs[]`
- Intended for mobile clients to fetch configuration and recent transactions.

Sample Request (Sync by Shop using Bearer)

GET /v1/laundry/shops/sync
Authorization: Bearer eyJhbGci...

Sample Response (200) - truncated

{
  "shop": { "shop_id": "SHOP-1a2b3c", "name": "Main Branch", "owner_id": "OP-abc123" },
  "staff": [{ "staff_id": "S-1", "name": "Alice", "role": "Operator" }],
  "machines": [{ "machine_id": "M-1", "name": "W-01", "status": "IDLE" }],
  "services": [{ "service_id": "SV-1", "name": "Wash & Dry", "price_per_unit": 120 }],
  "smsSubscriptions": [{ "shop_id": "SHOP-1a2b3c", "allocated_sms": 1000 }],
  "orders": [{ "order_id": "O-1", "order_number": "FG-1001", "total_amount": 250 }],
  "orderBatches": [],
  "customers": [],
  "smsTransactionLogs": []
}

8) Upsert Shop Data

- URL: `POST /v1/laundry/shops/upsert`
- Auth: Bearer `shop-jwt` or include `shopId` in body
- Body: JSON containing any combination of the following keys:
  - `staff`: array of staff objects (fields: `staffId`, `name`, `role`, `is_active`)
  - `machines`: array of machines (`machineId`, `name`, `capacityKg`, `status`, `lastMaintenanceDate`, `endTime`, `cyclesCount`, `assignedOrderId`)
  - `services`: array of services (`serviceId`, `name`, `defaultQuantity`, `unit`, `pricePerUnit`, `type`)
  - `sms_subscriptions`: object for the shop subscription (`planName`, `allocatedSms`, `usedSms`, `billingCycleStart`, `billingCycleEnd`, `isActive`)
  - `orders`: array of order objects (a large structure; at minimum provide `orderId` and `itemsJson` if updating)

- The endpoint performs `INSERT ... ON CONFLICT DO UPDATE` within a DB transaction and ensures atomic writes.

Example request

```bash
curl -X POST http://localhost:3000/v1/laundry/shops/upsert \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <shop-jwt>" \
  -d '{"staff":[{"staffId":"S-1","name":"Alice","role":"Operator"}], "machines":[{"machineId":"M-1","name":"W-01","capacityKg":10}] }'
```

  Sample Request (Upsert Shop Data)

  POST /v1/laundry/shops/upsert
  Content-Type: application/json
  Authorization: Bearer eyJhbGci...

  {
    "staff": [{ "staffId": "S-1", "name": "Alice", "role": "Operator", "is_active": true }],
    "machines": [{ "machineId": "M-1", "name": "W-01", "capacityKg": 10, "status": "IDLE" }],
    "services": [{ "serviceId": "SV-1", "name": "Wash & Dry", "defaultQuantity": 1, "unit": "KG", "pricePerUnit": 120 }],
    "sms_subscriptions": { "planName": "plan-basic", "allocatedSms": 1000, "usedSms": 0, "isActive": true },
    "orders": [{ "orderId": "O-1", "orderNumber": "FG-1001", "itemsJson": [{ "serviceId": "SV-1", "qty": 2 }], "totalAmount": 240 }]
  }

  Sample Response (200)

  { "status": "ok" }

9) Redirect Endpoints (Payment flow)

- `GET /v1/payments/redirect/success?ref=TXN-...&successUrl=...` — redirects to merchant `successUrl` with `referenceNumber` appended when present. Also renders a simple success HTML when `successUrl` not provided.
- `GET /v1/payments/redirect/cancel?ref=TXN-...&cancelUrl=...` — updates transaction status to `CANCELLED` if pending and redirects to `cancelUrl` when provided.

Developer Notes & Tips

- Validation: The server performs minimal validation. You should validate payloads on the client before sending.
- IDs: `operator_id`, `shop_id`, `order_id`, `machine_id`, etc., are treated as strings. Some code generates `OP-<hex>` and `SHOP-<hex>` programmatically.
- Dates: Timestamps are stored as SQL `TIMESTAMP`. Clients should convert to epoch ms if needed.
- Enums: Many `status` fields are stored as plain `VARCHAR` — consider adding DB `CHECK` constraints or `ENUM` types for stricter validation.
- Migration: If you want `operator_id` to be generated by Postgres, enable `pgcrypto`/`gen_random_uuid()` and adjust `schema.sql`.

Troubleshooting

- Webhook signature mismatch: Ensure `PAYMONGO_WH_SECRET` is configured and that the raw request body is not modified by other middleware before signature verification.
- CORS: `server.js` has a configured allowed origins list. Add local domains if your client is blocked.

Contact

If you need help extending or testing endpoints, tell me which endpoint and I can add sample Postman collections or automated tests.
