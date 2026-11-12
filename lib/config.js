import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

export const cfg = {
  port: num(process.env.PORT, 3000),
  openaiKey: process.env.OPENAI_API_KEY || '',
  whisperModel: process.env.WHISPER_MODEL || 'whisper-1',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  maxUploadMb: num(process.env.MAX_UPLOAD_MB, 2048),
  minClip: num(process.env.MIN_CLIP_SECONDS, 20),
  maxClip: num(process.env.MAX_CLIP_SECONDS, 75),
  maxClips: num(process.env.MAX_CLIPS, 8),
};

export const dirs = {
  root,
  data: path.join(root, 'data'),
  uploads: path.join(root, 'data', 'uploads'),
  projects: path.join(root, 'data', 'projects'),
  public: path.join(root, 'public'),
};
for (const d of [dirs.data, dirs.uploads, dirs.projects]) fs.mkdirSync(d, { recursive: true });
