// The known-answer vector shared with the gateway's MerchantApiRequestAuthenticator
// and the dashboard's Website integration tab (web-platform SIGNING_TEST_VECTOR).
// The secret is a dummy and authenticates nothing.
export const VECTOR = {
  secret: 'dms_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  timestamp: '1755302400',
  method: 'POST',
  path: '/merchant-api/checkout/sessions',
  idempotencyKey: '00000000-0000-4000-8000-000000000001',
  body: '{"amount":2500,"currency":"EUR","orderReference":"order-1042"}',
  bodySha256: 'aa3edd72cd1829f4e053abb048b08c1ae91c2d67b08955997c4b6c4dab4f98ff',
  signature: '95759958a0a0a9bd3e6e37101c01e8e7fee1166406e4ac2ff488764f5f742cbf',
}

// The cross-SDK webhook vector from WEBHOOKS-CONTRACT.md. Every Dominaite SDK pins this
// same byte sequence - the body is a single line reproduced exactly as the gateway sends
// it, so do NOT reformat, reindent or re-serialize it. The secret is a dummy.
export const WEBHOOK_VECTOR = {
  secret: 'whsec_abababababababababababababababababababababababababababababababab',
  timestamp: 1755700000,
  body: '{"id":"7f9c24e5-1d1f-4c0a-9b6c-2f3a4d5e6f70","type":"payment.succeeded","createdAt":"2026-08-20T14:00:00Z","data":{"transactionId":"0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0","status":"succeeded","previousStatus":"pending","kind":"sale","amount":8440,"grossAmount":8701,"surchargeAmount":261,"currency":"EUR","originalTransactionId":null,"idempotencyKey":"order-123"}}',
  header: 't=1755700000,v1=5305bcf1302fdaba8f8c19a20c899e916fb4d2a7d8d547c62529ff87c4697b72',
}
