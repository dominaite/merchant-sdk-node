// The known-answer vector shared with the gateway's MerchantApiRequestAuthenticator
// and the dashboard's Website integration tab (web-platform SIGNING_TEST_VECTOR).
// The secret is a dummy and authenticates nothing.
export const VECTOR = {
  secret: 'dms_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  timestamp: '1755302400',
  method: 'POST',
  path: '/merchant-api/bridgerpay/checkout/sessions',
  idempotencyKey: '00000000-0000-4000-8000-000000000001',
  body: '{"amount":2500,"currency":"EUR","orderReference":"order-1042"}',
  bodySha256: 'aa3edd72cd1829f4e053abb048b08c1ae91c2d67b08955997c4b6c4dab4f98ff',
  signature: '95759958a0a0a9bd3e6e37101c01e8e7fee1166406e4ac2ff488764f5f742cbf',
}
