/**
 * Caption building.
 *
 * Pure: text and a duration in, timed caption cues out. No I/O, so the whole
 * thing is testable in microseconds and the UI can preview exactly what will
 * be burned in.
 */

export interface Cue {
  /** Seconds from the start of the video. */
  start: number;
  end: number;
  /** Already wrapped to the line budget. */
  lines: string[];
}

/** Roughly the width that reads comfortably on a phone at caption size. */
const MAX_CHARS_PER_LINE = 22;
const MAX_LINES = 2;

/**
 * Split narration into caption-sized chunks.
 *
 * Chunks break on word boundaries and never exceed two lines, because a third
 * line pushes captions into the part of the frame most platforms cover with
 * their own UI.
 */
export function chunkText(text: string): string[][] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks: string[][] = [];
  let lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= MAX_CHARS_PER_LINE) {
      current = candidate;
      continue;
    }

    // The line is full. Commit it, and start the next one with this word — a
    // single word longer than the budget gets its own line rather than being
    // hyphenated, which reads worse than one overflowing line.
    if (current) lines.push(current);
    current = word;

    // `current` is deliberately left pending here: it belongs to the next
    // chunk, and flushing it too would make this one three lines tall.
    if (lines.length === MAX_LINES) {
      chunks.push(lines);
      lines = [];
    }
  }

  if (current) lines.push(current);
  if (lines.length) chunks.push(lines);

  return chunks;
}

/**
 * Distribute chunks across a scene's measured duration, proportional to how
 * much text each chunk holds.
 *
 * Even distribution looks wrong: a two-word chunk holds the screen as long as
 * a twelve-word one, and the captions visibly drift out of sync with the
 * voice.
 */
export function buildCues(text: string, startAt: number, duration: number): Cue[] {
  const chunks = chunkText(text);
  if (chunks.length === 0 || duration <= 0) return [];

  const weights = chunks.map((lines) => Math.max(1, lines.join(' ').length));
  const total = weights.reduce((sum, w) => sum + w, 0);

  const cues: Cue[] = [];
  let cursor = startAt;

  chunks.forEach((lines, index) => {
    const share = (weights[index]! / total) * duration;
    const isLast = index === chunks.length - 1;
    // The last cue is pinned to the scene end so rounding cannot leave a gap
    // or overrun into the next scene.
    const end = isLast ? startAt + duration : cursor + share;
    cues.push({ start: cursor, end, lines });
    cursor = end;
  });

  return cues;
}

/**
 * Captions are burned in from a generated ASS file rather than by `drawtext`.
 *
 * Two reasons. `drawtext` needs a freetype-enabled ffmpeg and one drawtext
 * filter per cue, which for a minute of narration is fifty filters in a chain.
 * ASS is one filter and one file, libass handles wrapping and outlines
 * properly, and the file is a readable artefact sitting next to the video when
 * a caption comes out wrong.
 */

/** ASS wants `H:MM:SS.cc`, and centiseconds are all it stores. */
export function assTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const centis = Math.round((clamped - Math.floor(clamped)) * 100);
  // Rounding 0.999 up to 100 centiseconds would print `:05.100`.
  const [s, c] = centis === 100 ? [secs + 1, 0] : [secs, centis];
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/**
 * Escape a caption for an ASS dialogue line.
 *
 * Braces open an override block in ASS, so a literal one would silently eat
 * the rest of the caption. Real newlines end the event; `\N` is the hard break.
 */
export function escapeAss(text: string): string {
  return text
    .replace(/\\/g, '∖')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, ' ');
}

export interface SubtitleEntry {
  narration: string;
  /** Seconds from the start of the video. */
  start: number;
  seconds: number;
}

/**
 * The whole caption track as one ASS file.
 *
 * `PlayResX/Y` are the real frame size, so every measurement below is in
 * output pixels rather than something libass has to scale.
 */
export function buildAssSubtitles(
  entries: SubtitleEntry[],
  frameWidth: number,
  frameHeight: number,
): string {
  const fontSize = Math.round(frameHeight * 0.033);
  // Alignment 2 is bottom-centre, so the margin is measured up from the
  // bottom edge. This lands captions just above the lower third, which is
  // where every platform puts its own buttons and handle.
  const marginV = Math.round(frameHeight * 0.24);
  const marginH = Math.round(frameWidth * 0.08);

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${frameWidth}`,
    `PlayResY: ${frameHeight}`,
    '',
    '[V4+ Styles]',
    // The V4+ format has 23 fields and SecondaryColour is one of them. Leaving
    // it out of this line while still supplying it below shifts every value
    // after it by one, and libass answers that by drawing nothing at all.
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Colours are &HAABBGGRR, and ASS inverts alpha: 00 is opaque, FF clear.
    // So: opaque white fill, opaque black outline, half-strength shadow.
    `Style: Caption,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${Math.round(
      fontSize * 0.14,
    )},2,2,${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events: string[] = [];
  for (const entry of entries) {
    for (const cue of buildCues(entry.narration, entry.start, entry.seconds)) {
      const text = cue.lines.map(escapeAss).join('\\N');
      events.push(
        `Dialogue: 0,${assTimestamp(cue.start)},${assTimestamp(cue.end)},Caption,,0,0,0,,${text}`,
      );
    }
  }

  return [...header, ...events, ''].join('\n');
}
