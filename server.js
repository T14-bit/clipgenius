import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { cfg, dirs } from './lib/config.js';
import * as store from './lib/store.js';
import { enqueue, processProject, renderClip, deleteProjectFiles } from './lib/pipeline.js';
import { probe } from './lib/ffmpeg.js';
import { PLANS, PACK, priceId, planForPrice } from './lib/plans.js';
import { balance, refreshAllowance, startAllowance, spend, costFor } from './lib/credits.js';
import { hashPassword, verifyPassword, makeToken, readToken, parseCookies, cookieHeader, clearCookie, COOKIE } from './lib/auth.js';
import { stripeEnabled, stripePost, verifyWebhook } from './lib/stripe.js';

await store.load();

const app = express();
app.set('trust proxy', 1); // behind Railway's proxy: use the real visitor IP for rate limiting
const APP_URL = (process.env.APP_URL || `http://localhost:${cfg.port}`).replace(/\/$/, '');
const ID = /^[0-9a-f-]{36}$/;

/* ---------------- Stripe webhook (needs the raw body, so it comes before express.json) ---------------- */
app.post('/api/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!verifyWebhook(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)) {
    return res.status(400).send('Invalid signature');
  }
  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).send('Bad payload'); }
  if (store.eventSeen(event.id)) return res.json({ received: true, duplicate: true });

  try {
    const o = event.data.object;
    if (event.type === 'checkout.session.completed') {
      const u = store.getUser(o.metadata?.user_id) || store.userByCustomer(o.customer);
      if (u && o.payment_status === 'paid') {
        if (o.customer) u.stripeCustomerId = o.customer;
        if (o.mode === 'subscription') {
          const plan = PLANS[String(o.metadata?.kind || '').replace('plan:', '')];
          if (plan) { u.plan = plan.id; u.subscriptionId = o.subscription; u.planCredits = plan.credits; }
        } else if (o.metadata?.kind === 'pack') {
          u.packCredits += PACK.credits;
        }
        await store.putUser(u);
      }
    } else if (event.type === 'invoice.paid' && o.billing_reason === 'subscription_cycle') {
      const u = store.userByCustomer(o.customer);
      if (u && PLANS[u.plan]) { u.planCredits = PLANS[u.plan].credits; await store.putUser(u); }
    } else if (event.type === 'customer.subscription.updated') {
      const u = store.userByCustomer(o.customer);
      const plan = planForPrice(o.items?.data?.[0]?.price?.id);
      if (u && plan && ['active', 'trialing'].includes(o.status) && plan.id !== u.plan) {
        u.planCredits = Math.max(0, u.planCredits + plan.credits - (PLANS[u.plan]?.credits || 0));
        u.plan = plan.id;
        u.subscriptionId = o.id;
        await store.putUser(u);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const u = store.userByCustomer(o.customer);
      if (u) {
        u.plan = 'free';
        u.subscriptionId = null;
        u.planCredits = Math.min(u.planCredits, PLANS.free.credits);
        u.resetAt = Date.now() + 30 * 864e5;
        await store.putUser(u);
      }
    }
    await store.markEvent(event.id);
    res.json({ received: true });
  } catch (e) {
    console.error('webhook error', e);
    res.status(500).send('Webhook handler failed'); // Stripe will retry
  }
});

app.use(express.json());

/* ---------------- Auth ---------------- */
const attempts = new Map(); // ip -> {n, t}
function limited(req) {
  const ip = req.ip, now = Date.now();
  const a = attempts.get(ip);
  if (!a || now - a.t > 15 * 60e3) { attempts.set(ip, { n: 1, t: now }); return false; }
  return ++a.n > 20;
}

function currentUser(req) {
  const id = readToken(parseCookies(req.headers.cookie)[COOKIE]);
  const u = id && store.getUser(id);
  if (u && refreshAllowance(u)) store.putUser(u);
  return u || null;
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Log in to continue.' });
  req.user = u;
  next();
}
const publicUser = (u) => ({
  id: u.id, email: u.email, plan: u.plan, planName: PLANS[u.plan]?.name || 'Free',
  credits: { plan: u.planCredits, pack: u.packCredits, total: balance(u) },
  resetAt: u.plan === 'free' ? u.resetAt : null,
  canManageBilling: !!u.stripeCustomerId,
});

app.post('/api/auth/signup', async (req, res) => {
  if (limited(req)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Use a password with at least 8 characters.' });
  if (store.userByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists. Log in instead.' });
  const u = { id: randomUUID(), email, passwordHash: hashPassword(password), plan: 'free', ...startAllowance(), createdAt: Date.now() };
  await store.putUser(u);
  res.setHeader('Set-Cookie', cookieHeader(makeToken(u.id)));
  res.status(201).json(publicUser(u));
});

app.post('/api/auth/login', (req, res) => {
  if (limited(req)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const u = store.userByEmail(String(req.body.email || '').trim().toLowerCase());
  if (!u || !verifyPassword(String(req.body.password || ''), u.passwordHash)) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  res.setHeader('Set-Cookie', cookieHeader(makeToken(u.id)));
  res.json(publicUser(u));
});

app.post('/api/auth/logout', (_req, res) => { res.setHeader('Set-Cookie', clearCookie); res.status(204).end(); });
app.get('/api/me', requireAuth, (req, res) => res.json(publicUser(req.user)));

/* ---------------- Plans & billing ---------------- */
app.get('/api/plans', (_req, res) => res.json({
  billingEnabled: stripeEnabled(),
  plans: Object.values(PLANS).map(({ id, name, price, credits }) => ({ id, name, price, credits })),
  pack: { price: PACK.price, credits: PACK.credits },
  creditUnit: '1 credit = 1 minute of uploaded video',
}));

app.post('/api/billing/checkout', requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const choice = req.body.plan;
    const item = choice === 'pack' ? PACK : PLANS[choice];
    if (!item || item.id === 'free') return res.status(400).json({ error: 'Choose Creator, Pro or a credit pack.' });
    const price = priceId(item);
    if (!price) return res.status(400).json({ error: `Billing is not set up for ${item.name} yet (missing ${item.priceEnv} in .env).` });
    if (choice !== 'pack' && u.subscriptionId) return res.status(400).json({ error: 'You already have a subscription. Use Manage billing to change plans.' });

    const session = await stripePost('/checkout/sessions', {
      mode: choice === 'pack' ? 'payment' : 'subscription',
      success_url: `${APP_URL}/?billing=success`,
      cancel_url: `${APP_URL}/?billing=cancelled`,
      client_reference_id: u.id,
      ...(u.stripeCustomerId ? { customer: u.stripeCustomerId } : { customer_email: u.email }),
      line_items: [{ price, quantity: 1 }],
      allow_promotion_codes: true,
      metadata: { user_id: u.id, kind: choice === 'pack' ? 'pack' : `plan:${choice}` },
    });
    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/billing/portal', requireAuth, async (req, res) => {
  try {
    if (!req.user.stripeCustomerId) return res.status(400).json({ error: 'No billing account yet. Buy a plan or pack first.' });
    const s = await stripePost('/billing_portal/sessions', { customer: req.user.stripeCustomerId, return_url: APP_URL });
    res.json({ url: s.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------------- Videos ---------------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _f, cb) => cb(null, dirs.uploads),
    filename: (_req, f, cb) => cb(null, randomUUID() + path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')),
  }),
  limits: { fileSize: cfg.maxUploadMb * 1024 * 1024 },
  fileFilter: (_req, f, cb) =>
    /\.(mp4|mov|webm|mkv|m4v)$/i.test(f.originalname) ? cb(null, true) : cb(new Error('Use an MP4, MOV, WEBM, MKV or M4V video.')),
});

const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const owned = (req) => (ID.test(req.params.id) ? store.get(req.params.id) : null);
const mine = (p, req) => p && p.ownerId === req.user.id;

function view(p) {
  return {
    id: p.id, name: p.name, status: p.status, progress: p.progress, error: p.error,
    createdAt: p.createdAt, duration: p.duration, language: p.language, cost: p.cost ? p.cost.fromPlan + p.cost.fromPack : 0,
    sourceUrl: `/media/${p.id}/${p.sourceFile}`,
    clips: (p.clips || []).map((c) => ({
      id: c.id, title: c.title, hook: c.hook, score: c.score, reason: c.reason, start: c.start, end: c.end,
      render: {
        status: c.render?.status || 'idle', error: c.render?.error,
        url: c.render?.file ? `/media/${p.id}/clips/${c.render.file}` : null, captions: c.render?.captions,
      },
    })),
  };
}

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, transcription: !!cfg.openaiKey, clipSelection: !!cfg.anthropicKey, maxUploadMb: cfg.maxUploadMb }));

app.get('/api/projects', requireAuth, (req, res) => res.json(store.all().filter((p) => mine(p, req)).map(view)));

app.get('/api/projects/:id', requireAuth, (req, res) => {
  const p = owned(req);
  return mine(p, req) ? res.json(view(p)) : res.status(404).json({ error: 'Video not found.' });
});

app.post('/api/projects', requireAuth, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a video to upload.' });
  const discard = () => fs.rm(req.file.path, { force: true });
  if (!cfg.openaiKey || !cfg.anthropicKey) {
    await discard();
    return res.status(400).json({ error: 'Server API keys are missing. Add OPENAI_API_KEY and ANTHROPIC_API_KEY to .env and restart.' });
  }
  let info;
  try { info = await probe(req.file.path); } catch (e) { await discard(); return res.status(400).json({ error: e.message }); }
  if (!info.hasVideo || !info.hasAudio) { await discard(); return res.status(400).json({ error: 'The video needs both a picture and an audio track.' }); }

  const u = req.user;
  const need = costFor(info.duration);
  const charged = spend(u, need); // synchronous: no await between the balance check and the deduction
  if (!charged) {
    await discard();
    return res.status(402).json({ error: `This video needs ${need} credits and you have ${balance(u)}. Upgrade your plan or buy a credit pack.`, needed: need, balance: balance(u) });
  }
  await store.putUser(u);

  const id = randomUUID();
  const dir = path.join(dirs.projects, id);
  await fs.mkdir(dir, { recursive: true });
  const sourceFile = 'source' + path.extname(req.file.filename);
  await fs.rename(req.file.path, path.join(dir, sourceFile));

  const minLen = clamp(req.body.minLen, 10, 120, cfg.minClip);
  const p = {
    id, ownerId: u.id, name: req.file.originalname.replace(/\.[^.]+$/, '').slice(0, 120), sourceFile,
    status: 'queued', progress: 'Waiting to start', createdAt: Date.now(), clips: [], cost: charged,
    options: {
      clipCount: clamp(req.body.clipCount, 1, 20, cfg.maxClips),
      minLen,
      maxLen: Math.max(minLen + 5, clamp(req.body.maxLen, 15, 180, cfg.maxClip)),
    },
  };
  await store.put(p);
  enqueue(() => processProject(id));
  res.status(201).json({ ...view(p), credits: publicUser(u).credits });
});

app.post('/api/projects/:id/clips/:cid/render', requireAuth, async (req, res) => {
  const p = owned(req);
  const clip = mine(p, req) && p.clips?.find((c) => c.id === req.params.cid);
  if (!clip) return res.status(404).json({ error: 'Clip not found.' });
  if (clip.render?.status === 'rendering') return res.status(409).json({ error: 'This clip is already rendering.' });

  const start = clamp(req.body.start, 0, p.duration, clip.start);
  const end = clamp(req.body.end, 0, p.duration, clip.end);
  if (end - start < 3) return res.status(400).json({ error: 'A clip must be at least 3 seconds long.' });
  if (end - start > 180) return res.status(400).json({ error: 'A clip can be at most 3 minutes long.' });
  clip.start = start;
  clip.end = end;
  clip.render = { status: 'rendering' };
  await store.save();
  enqueue(() => renderClip(p.id, clip.id, { start, end, captions: req.body.captions !== false }));
  res.status(202).json(view(p));
});

app.delete('/api/projects/:id', requireAuth, async (req, res) => {
  const p = owned(req);
  if (!mine(p, req)) return res.status(404).json({ error: 'Video not found.' });
  await store.remove(p.id);
  await deleteProjectFiles(p.id);
  res.status(204).end();
});

// Source videos and rendered clips are private to their owner. sendFile supports Range requests for seeking.
app.get('/media/:id/*', requireAuth, (req, res) => {
  const p = owned(req);
  if (!mine(p, req)) return res.status(404).end();
  const root = path.join(dirs.projects, p.id);
  const file = path.resolve(root, req.params[0] || '');
  if (!file.startsWith(root + path.sep) || path.basename(file).startsWith('.') || path.basename(file) === 'transcript.json') return res.status(404).end();
  res.sendFile(file, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

app.use(express.static(dirs.public));

app.use((err, _req, res, _next) => {
  const msg = err.code === 'LIMIT_FILE_SIZE' ? `That file is over the ${cfg.maxUploadMb} MB limit.` : err.message;
  res.status(400).json({ error: msg });
});

app.listen(cfg.port, () => console.log(`ClipGenius AI running at ${APP_URL}`));
