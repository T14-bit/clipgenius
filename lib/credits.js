import { PLANS } from './plans.js';

const nextMonth = (t) => { const d = new Date(t); d.setMonth(d.getMonth() + 1); return d.getTime(); };
export const balance = (u) => u.planCredits + u.packCredits;

// Free plan refills monthly. Paid plans refill when Stripe reports a paid renewal (see billing webhook).
export function refreshAllowance(u) {
  if (u.plan === 'free' && Date.now() >= (u.resetAt || 0)) {
    u.planCredits = PLANS.free.credits;
    u.resetAt = nextMonth(Date.now());
    return true;
  }
  return false;
}
export const startAllowance = () => ({ planCredits: PLANS.free.credits, packCredits: 0, resetAt: nextMonth(Date.now()) });

// Spends plan credits first, then purchased pack credits. Runs synchronously so two uploads cannot both pass the check.
export function spend(u, n) {
  if (balance(u) < n) return null;
  const fromPlan = Math.min(u.planCredits, n);
  u.planCredits -= fromPlan;
  u.packCredits -= n - fromPlan;
  return { fromPlan, fromPack: n - fromPlan };
}
export function refund(u, c) { u.planCredits += c.fromPlan; u.packCredits += c.fromPack; }
export const costFor = (seconds) => Math.max(1, Math.ceil(seconds / 60));
