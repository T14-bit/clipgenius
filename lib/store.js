// Tiny JSON-file store. Fine for a single server; swap for Postgres when you add accounts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { dirs } from './config.js';
import { refund } from './credits.js';

const FILE = path.join(dirs.data, 'db.json');
let db = { projects: {}, users: {}, events: [] };
let chain = Promise.resolve();

export async function load() {
  try {
    db = JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    db = { projects: {}, users: {}, events: [] };
  }
  db.projects ||= {}; db.users ||= {}; db.events ||= [];
  // Jobs interrupted by a restart cannot resume; mark them so the UI is honest.
  // Their upload charge must also be returned, just like a job that fails in-process.
  for (const p of Object.values(db.projects)) {
    if (!['ready', 'failed'].includes(p.status)) {
      p.status = 'failed';
      p.error = 'Server restarted during processing. Delete this video and upload it again.';
      const owner = db.users[p.ownerId];
      if (owner && p.cost && !p.refunded) {
        refund(owner, p.cost);
        p.refunded = true;
      }
    }
    for (const c of p.clips || []) {
      if (c.render?.status === 'rendering') c.render = { status: 'failed', error: 'Interrupted by restart.' };
    }
  }
  await save();
}

export function save() {
  chain = chain
    .then(async () => {
      await fs.writeFile(FILE + '.tmp', JSON.stringify(db));
      await fs.rename(FILE + '.tmp', FILE);
    })
    .catch((e) => console.error('store save failed:', e));
  return chain;
}

export const all = () => Object.values(db.projects).sort((a, b) => b.createdAt - a.createdAt);
export const get = (id) => db.projects[id];
export const put = (p) => { db.projects[p.id] = p; return save(); };
export const remove = (id) => { delete db.projects[id]; return save(); };

export const getUser = (id) => db.users[id];
export const userByEmail = (email) => Object.values(db.users).find((u) => u.email === email);
export const userByCustomer = (cid) => cid && Object.values(db.users).find((u) => u.stripeCustomerId === cid);
export const putUser = (u) => { db.users[u.id] = u; return save(); };
export const eventSeen = (id) => db.events.includes(id);
export const markEvent = (id) => { db.events.push(id); db.events = db.events.slice(-500); return save(); };
