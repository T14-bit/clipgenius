import fs from 'node:fs/promises';
import { cfg } from './config.js';

// Transcribes one audio chunk with the OpenAI Whisper API; timestamps are shifted by `offset` seconds.
export async function transcribeChunk(file, offset = 0) {
  if (!cfg.openaiKey) throw new Error('OPENAI_API_KEY is not set. Add it to .env to enable transcription.');
  const form = new FormData();
  form.append('file', new Blob([await fs.readFile(file)], { type: 'audio/mpeg' }), 'audio.mp3');
  form.append('model', cfg.whisperModel);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.openaiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  return {
    language: j.language,
    segments: (j.segments || []).map((s) => ({ start: s.start + offset, end: s.end + offset, text: s.text.trim() })),
    words: (j.words || []).map((w) => ({ word: w.word, start: w.start + offset, end: w.end + offset })),
  };
}
