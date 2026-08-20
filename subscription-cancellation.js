import { editSubscription, listSubscriptionRecords } from './subscription-model.js';

export const CANCELLATION_MANAGEMENT = Object.freeze({ PROVIDER: 'provider', APPLE: 'apple', MANUAL: 'manual' });
export const CANCELLATION_ROUTE_TYPE = Object.freeze({ DIRECT: 'direct', HELP: 'help', GENERAL: 'general', MANUAL: 'manual' });
export const APPLE_SUBSCRIPTIONS_URL = 'https://account.apple.com/account/manage/section/subscriptions';

const PREFIX = 'cancel';
const MAX_REFERENCE = 200;
const MAX_URL = 120;

export function resolveCancellationRoute(record = {}) {
  const decoded = decodeCancellationReference(record.cancellationMetadataRef);
  if (!decoded) return manualRoute('No verified cancellation destination is stored. Check the provider that bills you and use its official account/help route.');
  if (decoded.managementType === CANCELLATION_MANAGEMENT.APPLE) {
    return {
      managementType: CANCELLATION_MANAGEMENT.APPLE,
      routeType: CANCELLATION_ROUTE_TYPE.GENERAL,
      url: APPLE_SUBSCRIPTIONS_URL,
      label: 'Open Apple subscriptions',
      guidance: 'Apple manages this subscription. Open Apple’s generic subscription-management page and choose the subscription there.',
      provenance: 'official_apple'
    };
  }
  if (decoded.managementType === CANCELLATION_MANAGEMENT.MANUAL || !decoded.url) return manualRoute('No reliable online destination is stored. Use the provider’s own account, receipt or support contact and confirm any notice period or fee before cancelling.');
  return {
    managementType: CANCELLATION_MANAGEMENT.PROVIDER,
    routeType: decoded.routeType,
    url: decoded.url,
    label: routeLabel(decoded.routeType),
    guidance: routeGuidance(decoded.routeType),
    provenance: 'user_verified_official'
  };
}

export function setSubscriptionCancellationRoute(state, subscriptionId, input = {}, now = new Date()) {
  const id = String(subscriptionId || '');
  if (!listSubscriptionRecords(state).some((record) => record.id === id)) throw new Error('That subscription is no longer available.');
  const managementType = Object.values(CANCELLATION_MANAGEMENT).includes(input.managementType) ? input.managementType : CANCELLATION_MANAGEMENT.MANUAL;
  let cancellationMetadataRef;
  if (managementType === CANCELLATION_MANAGEMENT.APPLE) cancellationMetadataRef = `${PREFIX}.apple.official`;
  else if (managementType === CANCELLATION_MANAGEMENT.MANUAL) cancellationMetadataRef = `${PREFIX}.manual.user`;
  else {
    const routeType = [CANCELLATION_ROUTE_TYPE.DIRECT, CANCELLATION_ROUTE_TYPE.HELP, CANCELLATION_ROUTE_TYPE.GENERAL].includes(input.routeType)
      ? input.routeType : CANCELLATION_ROUTE_TYPE.GENERAL;
    const url = validateExternalDestination(input.officialUrl);
    const encoded = encodeBase64Url(url);
    cancellationMetadataRef = `${PREFIX}.provider.${routeType}.${encoded}`;
    if (cancellationMetadataRef.length > MAX_REFERENCE) throw new TypeError('That official cancellation URL is too long to store safely. Use a shorter official destination or manual guidance.');
  }
  return editSubscription(state, id, { cancellationMetadataRef }, now);
}

export function clearSubscriptionCancellationRoute(state, subscriptionId, now = new Date()) {
  return editSubscription(state, subscriptionId, { cancellationMetadataRef: null }, now);
}

export function validateExternalDestination(value) {
  const text = String(value || '').trim();
  if (!text || text.length > MAX_URL) throw new TypeError('Enter a shorter official HTTPS destination.');
  let url;
  try { url = new URL(text); } catch { throw new TypeError('Enter a valid official HTTPS destination.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new TypeError('Only standard HTTPS provider destinations can be opened.');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || isPrivateIpLiteral(host)) {
    throw new TypeError('That destination is not a public provider website.');
  }
  return url.toString();
}

export function decodeCancellationReference(reference) {
  const text = String(reference || '');
  if (text === `${PREFIX}.apple.official`) return { managementType: CANCELLATION_MANAGEMENT.APPLE, routeType: CANCELLATION_ROUTE_TYPE.GENERAL, url: APPLE_SUBSCRIPTIONS_URL };
  if (text === `${PREFIX}.manual.user`) return { managementType: CANCELLATION_MANAGEMENT.MANUAL, routeType: CANCELLATION_ROUTE_TYPE.MANUAL, url: null };
  const match = text.match(/^cancel\.provider\.(direct|help|general)\.([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  try {
    const url = validateExternalDestination(decodeBase64Url(match[2]));
    return { managementType: CANCELLATION_MANAGEMENT.PROVIDER, routeType: match[1], url };
  } catch { return null; }
}

function manualRoute(guidance) {
  return { managementType: CANCELLATION_MANAGEMENT.MANUAL, routeType: CANCELLATION_ROUTE_TYPE.MANUAL, url: null, label: 'Manual cancellation guidance', guidance, provenance: 'local_manual' };
}
function routeLabel(type) {
  if (type === CANCELLATION_ROUTE_TYPE.DIRECT) return 'Open official cancellation page';
  if (type === CANCELLATION_ROUTE_TYPE.HELP) return 'Open official cancellation instructions';
  return 'Open official subscription management';
}
function routeGuidance(type) {
  if (type === CANCELLATION_ROUTE_TYPE.DIRECT) return 'This stored destination is intended to take you to the provider’s official cancellation or account-management flow.';
  if (type === CANCELLATION_ROUTE_TYPE.HELP) return 'This stored destination contains the provider’s official cancellation instructions.';
  return 'This stored destination opens the provider’s official general subscription/account-management page.';
}
function encodeBase64Url(text) {
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8').toString('base64url');
  const bytes = new TextEncoder().encode(text); let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function decodeBase64Url(value) {
  if (typeof Buffer !== 'undefined') return Buffer.from(value, 'base64url').toString('utf8');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(base64); const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function isPrivateIpLiteral(host) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    return parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || parts[0] === 0;
  }
  return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
}
