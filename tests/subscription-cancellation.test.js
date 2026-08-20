import assert from 'node:assert/strict';
import test from 'node:test';
import { createManualSubscription, listSubscriptionRecords } from '../subscription-model.js';
import {
  APPLE_SUBSCRIPTIONS_URL,
  CANCELLATION_MANAGEMENT,
  CANCELLATION_ROUTE_TYPE,
  decodeCancellationReference,
  resolveCancellationRoute,
  setSubscriptionCancellationRoute,
  validateExternalDestination
} from '../subscription-cancellation.js';

test('Apple-managed subscriptions use the verified generic Apple subscriptions route', () => {
  let state = withSubscription(); const id = listSubscriptionRecords(state)[0].id;
  state = setSubscriptionCancellationRoute(state, id, { managementType: CANCELLATION_MANAGEMENT.APPLE }, at(1));
  const record = listSubscriptionRecords(state)[0]; const route = resolveCancellationRoute(record);
  assert.equal(route.managementType, CANCELLATION_MANAGEMENT.APPLE);
  assert.equal(route.url, APPLE_SUBSCRIPTIONS_URL);
  assert.equal(route.url, 'https://account.apple.com/account/manage/section/subscriptions');
  assert.equal(route.provenance, 'official_apple');
});

test('provider direct, help and general routes round-trip through the authoritative subscription record', () => {
  for (const type of [CANCELLATION_ROUTE_TYPE.DIRECT, CANCELLATION_ROUTE_TYPE.HELP, CANCELLATION_ROUTE_TYPE.GENERAL]) {
    let state = withSubscription(); const id = listSubscriptionRecords(state)[0].id;
    state = setSubscriptionCancellationRoute(state, id, { managementType: CANCELLATION_MANAGEMENT.PROVIDER, routeType: type, officialUrl: `https://subscriptions.example.com/${type}` }, at(2));
    const record = listSubscriptionRecords(JSON.parse(JSON.stringify(state)))[0];
    assert.ok(record.cancellationMetadataRef);
    const decoded = decodeCancellationReference(record.cancellationMetadataRef);
    assert.equal(decoded.routeType, type);
    assert.equal(decoded.url, `https://subscriptions.example.com/${type}`);
    assert.equal(resolveCancellationRoute(record).provenance, 'user_verified_official');
  }
});

test('unknown or manual routing fails conservatively without inventing a destination', () => {
  const record = listSubscriptionRecords(withSubscription())[0];
  assert.equal(resolveCancellationRoute(record).url, null);
  let state = withSubscription(); const id = listSubscriptionRecords(state)[0].id;
  state = setSubscriptionCancellationRoute(state, id, { managementType: CANCELLATION_MANAGEMENT.MANUAL }, at(3));
  const route = resolveCancellationRoute(listSubscriptionRecords(state)[0]);
  assert.equal(route.routeType, CANCELLATION_ROUTE_TYPE.MANUAL);
  assert.equal(route.url, null);
  assert.match(route.guidance, /notice period|provider/i);
});

test('unsafe external destinations are rejected before storage or navigation', () => {
  for (const value of ['http://example.com/cancel', 'file:///tmp/test', 'javascript:alert(1)', 'https://localhost/cancel', 'https://127.0.0.1/cancel', 'https://192.168.1.2/cancel', 'https://user:pass@example.com/cancel']) {
    assert.throws(() => validateExternalDestination(value));
  }
  assert.equal(validateExternalDestination('https://support.example.com/cancel'), 'https://support.example.com/cancel');
});

test('saving cancellation guidance does not create or infer a cancelled lifecycle state', () => {
  let state = withSubscription(); const before = listSubscriptionRecords(state)[0];
  state = setSubscriptionCancellationRoute(state, before.id, { managementType: CANCELLATION_MANAGEMENT.APPLE }, at(4));
  const after = listSubscriptionRecords(state)[0];
  assert.equal(after.id, before.id);
  assert.equal(after.decisionState, before.decisionState);
  assert.equal(after.visibility, before.visibility);
  assert.equal(Object.hasOwn(after, 'lifecycleStatus'), false);
});

function withSubscription() {
  return createManualSubscription({ transactions: [], scheduledPayments: [], accounts: [], debts: [], overdrafts: [], budgets: [], tasks: [], reviewItems: [], profile: {}, settings: {}, automation: {} }, { providerName: 'Fictional Service', amount: 10, cadence: 'monthly' }, at(0));
}
function at(minutes) { return new Date(Date.UTC(2026, 7, 20, 9, minutes, 0)); }
