import { cfg } from '../lib/config.js';
import { run } from '../lib/ffmpeg.js';

const ok = (m) => console.log('  ok   ' + m);
const bad = (m) => { console.log('  FAIL ' + m); process.exitCode = 1; };

console.log('ClipGenius setup check');
for (const bin of ['ffmpeg', 'ffprobe']) {
  await run(bin, ['-version']).then(() => ok(bin + ' found'), () => bad(bin + ' not found on PATH'));
}
await run('ffmpeg', ['-hide_banner', '-filters']).catch(() => {});
cfg.openaiKey ? ok('OPENAI_API_KEY set') : bad('OPENAI_API_KEY missing');
cfg.anthropicKey ? ok('ANTHROPIC_API_KEY set') : bad('ANTHROPIC_API_KEY missing');
