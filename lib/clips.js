import { cfg } from './config.js';

const WINDOW_SECONDS = 1500; // analyze long videos in ~25 min windows

function fmt(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function parseJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end < 0) throw new Error('Model did not return a JSON list.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function askClaude(segments, want, minLen, maxLen) {
  const transcript = segments.map((s) => `[${s.start.toFixed(1)}] ${s.text}`).join('\n');
  const system =
    'You are an editor who finds the moments in long videos most likely to perform as short-form clips (TikTok, Reels, Shorts). ' +
    'Respond with ONLY a JSON array, no prose and no code fences.';
  const prompt =
    `Below is a timestamped transcript. Each line starts with the start time in seconds.\n` +
    `Pick up to ${want} clips. Each clip must:\n` +
    `- run ${minLen} to ${maxLen} seconds\n` +
    `- start at the beginning of a line and end at the end of a line, on a complete thought\n` +
    `- open with a hook (a claim, question, story beat or surprise) and make sense without the rest of the video\n` +
    `- not overlap another clip\n` +
    `Score each from 0 to 100 on hook strength, emotional intensity, and standalone clarity.\n` +
    `Return: [{"start": <seconds>, "end": <seconds>, "title": "<=60 chars", "hook": "the opening line", "score": <int>, "reason": "one sentence"}]\n` +
    `If nothing is clip-worthy, return [].\n\nTRANSCRIPT:\n${transcript}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.claudeModel,
      max_tokens: 4000,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Clip analysis failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return parseJson(text);
}

// Snap a model-proposed time to the nearest segment boundary so clips never cut mid-sentence.
function snap(t, segments, edge) {
  let best = segments[0], bd = Infinity;
  for (const s of segments) {
    const d = Math.abs(s[edge] - t);
    if (d < bd) { bd = d; best = s; }
  }
  return best[edge];
}

export async function selectClips({ segments, duration, maxClips = cfg.maxClips, minLen = cfg.minClip, maxLen = cfg.maxClip }) {
  if (!cfg.anthropicKey) throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env to enable clip selection.');
  if (!segments.length) return [];

  const windows = [];
  for (let t = 0; t < duration; t += WINDOW_SECONDS) {
    const part = segments.filter((s) => s.start >= t && s.start < t + WINDOW_SECONDS);
    if (part.length) windows.push(part);
  }
  const perWindow = Math.max(2, Math.ceil((maxClips * 1.5) / windows.length));

  let raw = [];
  for (const w of windows) raw = raw.concat(await askClaude(w, perWindow, minLen, maxLen));

  const clean = [];
  for (const c of raw) {
    if (![c.start, c.end].every(Number.isFinite)) continue;
    const start = snap(c.start, segments, 'start');
    const end = snap(c.end, segments, 'end');
    const len = end - start;
    if (len < minLen * 0.8 || len > maxLen * 1.2) continue;
    clean.push({
      start: Math.max(0, start),
      end: Math.min(duration, end),
      title: String(c.title || 'Untitled clip').slice(0, 80),
      hook: String(c.hook || '').slice(0, 200),
      score: Math.max(0, Math.min(100, Math.round(Number(c.score) || 0))),
      reason: String(c.reason || '').slice(0, 240),
    });
  }

  clean.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of clean) {
    if (picked.some((p) => c.start < p.end && c.end > p.start)) continue; // drop overlaps
    picked.push(c);
    if (picked.length >= maxClips) break;
  }
  return picked.map((c, i) => ({ id: `c${i + 1}`, ...c, label: `${fmt(c.start)}–${fmt(c.end)}`, render: { status: 'idle' } }));
}
