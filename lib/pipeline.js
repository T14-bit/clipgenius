import fs from 'node:fs/promises';
import path from 'node:path';
import { cfg, dirs } from './config.js';
import * as store from './store.js';
import { run, probe } from './ffmpeg.js';
import { transcribeChunk } from './transcribe.js';
import { selectClips } from './clips.js';
import { buildAss } from './captions.js';
import { refund } from './credits.js';

// One job at a time: video work is CPU heavy and this keeps a small server stable.
let queue = Promise.resolve();
export const enqueue = (fn) => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
};

const projectDir = (id) => path.join(dirs.projects, id);

async function setStatus(p, status, progress) {
  p.status = status;
  p.progress = progress;
  await store.save();
}

export async function processProject(id) {
  const p = store.get(id);
  if (!p) return;
  const dir = projectDir(id);
  const source = path.join(dir, p.sourceFile);
  try {
    await setStatus(p, 'extracting', 'Reading the video and extracting audio');
    const info = await probe(source);
    if (!info.hasVideo) throw new Error('This file has no video track.');
    if (!info.hasAudio) throw new Error('This video has no audio track, so there is nothing to transcribe.');
    p.duration = info.duration;
    p.width = info.width;
    p.height = info.height;

    const audioDir = path.join(dir, 'audio');
    await fs.rm(audioDir, { recursive: true, force: true });
    await fs.mkdir(audioDir, { recursive: true });
    const CHUNK = 600;
    await run('ffmpeg', [
      '-y', '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k',
      '-f', 'segment', '-segment_time', String(CHUNK), '-reset_timestamps', '1',
      path.join(audioDir, 'chunk_%03d.mp3'),
    ]);
    const chunks = (await fs.readdir(audioDir)).filter((f) => f.endsWith('.mp3')).sort();

    const transcript = { language: null, segments: [], words: [] };
    for (let i = 0; i < chunks.length; i++) {
      await setStatus(p, 'transcribing', `Transcribing part ${i + 1} of ${chunks.length}`);
      const t = await transcribeChunk(path.join(audioDir, chunks[i]), i * CHUNK);
      transcript.language ||= t.language;
      transcript.segments.push(...t.segments);
      transcript.words.push(...t.words);
    }
    await fs.writeFile(path.join(dir, 'transcript.json'), JSON.stringify(transcript));
    await fs.rm(audioDir, { recursive: true, force: true });
    if (!transcript.segments.length) throw new Error('No speech was detected in this video.');

    await setStatus(p, 'analyzing', 'Finding the strongest moments');
    p.clips = await selectClips({
      segments: transcript.segments,
      duration: info.duration,
      maxClips: p.options.clipCount,
      minLen: p.options.minLen,
      maxLen: p.options.maxLen,
    });
    p.language = transcript.language;
    await setStatus(p, 'ready', p.clips.length ? '' : 'No clip-worthy moments were found in this video.');
  } catch (e) {
    console.error(`[project ${id}]`, e);
    p.status = 'failed';
    p.error = e.message;
    // A failed analysis costs the person nothing: give the credits back once.
    const owner = store.getUser(p.ownerId);
    if (owner && p.cost && !p.refunded) { refund(owner, p.cost); p.refunded = true; await store.putUser(owner); }
    await store.save();
  }
}

export async function renderClip(pid, cid, { start, end, captions }) {
  const p = store.get(pid);
  const clip = p?.clips?.find((c) => c.id === cid);
  if (!clip) return;
  const dir = projectDir(pid);
  const outDir = path.join(dir, 'clips');
  await fs.mkdir(outDir, { recursive: true });
  const outName = `${cid}-${Date.now()}.mp4`;
  const tmp = path.join(outDir, `.work-${cid}`);

  try {
    clip.render = { status: 'rendering' };
    await store.save();
    await fs.mkdir(tmp, { recursive: true });

    const duration = end - start;
    const filters = [];
    const portrait = p.width && p.height && p.width / p.height <= 0.6;
    if (portrait) {
      filters.push('[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[base]');
    } else {
      // Landscape or square: speaker sharp in the middle, blurred copy fills the frame behind.
      filters.push('[0:v]split[a][b]');
      filters.push('[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:6[bg]');
      filters.push('[b]scale=1080:-2[fg]');
      filters.push('[bg][fg]overlay=(W-w)/2:(H-h)/2[base]');
    }
    if (captions) {
      const t = JSON.parse(await fs.readFile(path.join(dir, 'transcript.json'), 'utf8'));
      await fs.writeFile(path.join(tmp, 'captions.ass'), buildAss(t.words, start, end));
      filters.push('[base]subtitles=captions.ass[out]');
    } else {
      filters.push('[base]null[out]');
    }

    // cwd = tmp so the subtitle filename needs no path escaping.
    await run('ffmpeg', [
      '-y', '-ss', String(start), '-t', String(duration), '-i', path.join(dir, p.sourceFile),
      '-filter_complex', filters.join(';'), '-map', '[out]', '-map', '0:a:0',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
      path.join(outDir, outName),
    ], { cwd: tmp });

    // remove older renders of this clip
    for (const f of await fs.readdir(outDir)) {
      if (f.startsWith(`${cid}-`) && f !== outName) await fs.rm(path.join(outDir, f), { force: true });
    }
    clip.render = { status: 'done', file: outName, captions, start, end };
  } catch (e) {
    console.error(`[render ${pid}/${cid}]`, e);
    clip.render = { status: 'failed', error: e.message };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
    await store.save();
  }
}

export async function deleteProjectFiles(id) {
  await fs.rm(projectDir(id), { recursive: true, force: true });
}
