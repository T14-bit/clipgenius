import crypto from 'node:crypto';

const key = () => process.env.STRIPE_SECRET_KEY || '';
export const stripeEnabled = () => !!key();

function flatten(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const name = prefix ? `${prefix}[${k}]` : k;
    if (v == null) continue;
    if (typeof v === 'object') flatten(v, name, out);
    else out.append(name, String(v));
  }
  return out;
}

export async function stripePost(path, params) {
  if (!key()) throw new Error('Billing is not configured. Add STRIPE_SECRET_KEY to .env.');
  const res = await fetch('https://api.stripe.com/v1' + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key()}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: flatten(params),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || `Stripe error (${res.status})`);
  return j;
}

// Verifies the Stripe-Signature header against the raw request body.
export function verifyWebhook(raw, header, secret, toleranceSec = 300) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k, v]));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw.toString('utf8')}`).digest('hex');
  return header.split(',').filter((p) => p.startsWith('v1=')).some((p) => {
    const got = Buffer.from(p.slice(3), 'hex'), want = Buffer.from(expected, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
}
