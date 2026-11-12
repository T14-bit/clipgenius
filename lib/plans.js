// Edit prices and allowances here. 1 credit = 1 minute of uploaded video (rounded up).
// Stripe price IDs come from .env; the dollar amounts below are what the UI displays.
export const PLANS = {
  free:    { id: 'free',    name: 'Free',    price: 0,  credits: 30 },
  creator: { id: 'creator', name: 'Creator', price: 15, credits: 300,  priceEnv: 'STRIPE_PRICE_CREATOR' },
  pro:     { id: 'pro',     name: 'Pro',     price: 39, credits: 1200, priceEnv: 'STRIPE_PRICE_PRO' },
};
export const PACK = { id: 'pack', name: 'Credit pack', price: 10, credits: 100, priceEnv: 'STRIPE_PRICE_PACK' };

export const priceId = (p) => (p?.priceEnv ? process.env[p.priceEnv] || '' : '');
export const planForPrice = (id) => Object.values(PLANS).find((p) => p.priceEnv && priceId(p) === id);
