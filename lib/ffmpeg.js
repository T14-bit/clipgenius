import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

export function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, opts);
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => reject(new Error(`Could not start ${bin}. Is FFmpeg installed and on your PATH? (${e.message})`)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${bin} failed (exit ${code}): ${err.slice(-500)}`))));
  });
}

export async function probe(file) {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height:format=duration',
    '-of', 'json', file,
  ]).catch((e) => { throw new Error(`ffprobe failed. Is FFmpeg installed? (${e.message})`); });
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  return {
    duration: Number(j.format?.duration) || 0,
    width: v?.width || 0,
    height: v?.height || 0,
    hasVideo: !!v,
    hasAudio: !!a,
  };
}
