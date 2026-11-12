// Builds an ASS subtitle file from word timestamps, grouped into short on-screen phrases.
const ts = (t) => {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};
const esc = (s) => s.replace(/[{}\\]/g, '').replace(/\n/g, ' ');

export function buildAss(words, clipStart, clipEnd) {
  const inClip = words.filter((w) => w.end > clipStart && w.start < clipEnd);
  const groups = [];
  let cur = [];
  for (const w of inClip) {
    cur.push(w);
    const text = cur.map((x) => x.word.trim()).join(' ');
    const endsSentence = /[.!?]$/.test(w.word.trim());
    if (cur.length >= 4 || text.length > 22 || endsSentence) { groups.push(cur); cur = []; }
  }
  if (cur.length) groups.push(cur);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,84,&H00FFFFFF,&H00FFFFFF,&H00331A0B,&H80000000,-1,0,0,0,100,100,0,0,1,6,2,2,60,60,420,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = groups.map((g, i) => {
    const start = Math.max(g[0].start, clipStart) - clipStart;
    const nextStart = groups[i + 1] ? groups[i + 1][0].start : Infinity;
    const end = Math.min(g[g.length - 1].end + 0.15, nextStart, clipEnd) - clipStart;
    const text = esc(g.map((x) => x.word.trim()).join(' ')).toUpperCase();
    return `Dialogue: 0,${ts(start)},${ts(Math.max(end, start + 0.2))},Default,,0,0,0,,${text}`;
  });
  return header + lines.join('\n') + '\n';
}
