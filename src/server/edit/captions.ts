import type {
  CaptionCue,
  CaptionStyle,
  CaptionToken,
  Transcript,
  TranscriptWord,
} from '@/lib/types';
import { clamp, formatAssTimecode, formatSrtTimecode, formatTimecode, round } from '@/lib/time';
import { isStopWord, normalizeWord } from '@/lib/text';

/**
 * Caption generation.
 *
 * Word-level ASR timings are grouped into cues that are comfortable to read at
 * short-form pace, keywords are marked for the highlight animation, and the
 * result is serialised to SRT/VTT (for platforms) or ASS (for burn-in, which is
 * what actually gets the animated look).
 */

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: 'Inter',
  fontSizePx: 64,
  primaryColor: '#FFFFFF',
  highlightColor: '#7C5CFF',
  outlineColor: '#000000',
  outlineWidth: 4,
  shadow: 2,
  bold: true,
  uppercase: false,
  positionY: 0.72,
  animation: 'karaoke',
  maxCharsPerLine: 22,
  maxLines: 2,
};

export interface CaptionOptions {
  /** Longest a single cue may stay on screen. */
  maxCueDurationSec: number;
  /** Shortest a cue may be shown, even if the words are faster. */
  minCueDurationSec: number;
  /** Words per cue upper bound; readability beats packing. */
  maxWordsPerCue: number;
  /** A pause at least this long forces a cue break. */
  breakOnPauseSec: number;
  /** Highlight the most information-bearing words. */
  highlightKeywords: boolean;
  /** Maximum fraction of words that may be highlighted in a cue. */
  maxHighlightRatio: number;
  /** Character budget for a cue before a break is forced. */
  maxCharsPerCue: number;
  uppercase: boolean;
}

export const DEFAULT_CAPTION_OPTIONS: CaptionOptions = {
  maxCueDurationSec: 3.2,
  minCueDurationSec: 0.5,
  maxWordsPerCue: 6,
  breakOnPauseSec: 0.45,
  highlightKeywords: true,
  maxHighlightRatio: 0.4,
  maxCharsPerCue: 46,
  uppercase: false,
};

/**
 * Group words into cues.
 *
 * Breaks are forced by, in priority order: sentence-ending punctuation, a pause
 * longer than `breakOnPauseSec`, the word budget, the duration budget, and the
 * character budget. Punctuation first means cues almost always end on a
 * complete thought.
 */
export function groupWordsIntoCues(
  words: TranscriptWord[],
  options: Partial<CaptionOptions> = {},
): TranscriptWord[][] {
  const opts = { ...DEFAULT_CAPTION_OPTIONS, ...options };
  const cues: TranscriptWord[][] = [];
  let current: TranscriptWord[] = [];

  const flush = () => {
    if (current.length > 0) {
      cues.push(current);
      current = [];
    }
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    current.push(word);

    const next = words[i + 1];
    if (!next) break;

    const first = current[0]!;
    const charCount = current.reduce((sum, w) => sum + w.text.length + 1, 0);
    const cueDuration = word.end - first.start;
    const pause = next.start - word.end;

    const endsSentence = /[.!?]["')\]]?$/.test(word.text.trim());
    const endsClause = /[,;:—]$/.test(word.text.trim());

    if (
      endsSentence ||
      pause >= opts.breakOnPauseSec ||
      current.length >= opts.maxWordsPerCue ||
      cueDuration >= opts.maxCueDurationSec ||
      charCount >= opts.maxCharsPerCue
    ) {
      flush();
      continue;
    }

    // A comma is a soft break: only take it if the cue is already substantial.
    if (endsClause && current.length >= Math.ceil(opts.maxWordsPerCue * 0.6)) {
      flush();
    }
  }

  flush();
  return cues;
}

/**
 * Decide which words in a cue get the highlight treatment.
 *
 * Highlighting everything defeats the purpose, so the budget is capped by
 * `maxHighlightRatio` and stop words are never eligible. Numbers and long
 * content words score highest, since those carry the information a viewer is
 * skimming for.
 */
export function selectHighlights(
  cueWords: TranscriptWord[],
  globalKeywords: Set<string>,
  options: Partial<CaptionOptions> = {},
): Set<number> {
  const opts = { ...DEFAULT_CAPTION_OPTIONS, ...options };
  if (!opts.highlightKeywords) return new Set();

  const scored = cueWords
    .map((word, index) => {
      const normalized = normalizeWord(word.text);
      if (normalized.length < 3 || isStopWord(normalized)) return null;

      let score = 0;
      if (globalKeywords.has(normalized)) score += 0.5;
      if (/\d/.test(word.text)) score += 0.6;
      if (normalized.length >= 7) score += 0.25;
      if (/[!?]$/.test(word.text.trim())) score += 0.2;
      if (word.text === word.text.toUpperCase() && normalized.length > 2) score += 0.3;

      return score > 0 ? { index, score } : null;
    })
    .filter((entry): entry is { index: number; score: number } => entry !== null)
    .sort((a, b) => b.score - a.score);

  const budget = Math.max(1, Math.floor(cueWords.length * opts.maxHighlightRatio));
  return new Set(scored.slice(0, budget).map((entry) => entry.index));
}

/** Full caption pass: transcript in, styled cues out. */
export function buildCaptions(
  transcript: Transcript,
  options: Partial<CaptionOptions> = {},
): CaptionCue[] {
  const opts = { ...DEFAULT_CAPTION_OPTIONS, ...options };

  const globalKeywords = new Set(
    [...countKeywords(transcript).entries()]
      .filter(([, count]) => count >= 2)
      .map(([word]) => word),
  );

  const groups = groupWordsIntoCues(transcript.words, opts);

  return groups.map((group, index) => {
    const highlights = selectHighlights(group, globalKeywords, opts);
    const first = group[0]!;
    const last = group[group.length - 1]!;

    const tokens: CaptionToken[] = group.map((word, wordIndex) => ({
      text: opts.uppercase ? word.text.toUpperCase() : word.text,
      start: round(word.start),
      end: round(word.end),
      highlight: highlights.has(wordIndex),
    }));

    const start = round(first.start);
    const end = round(Math.max(last.end, first.start + opts.minCueDurationSec));

    return {
      index: index + 1,
      start,
      end,
      text: tokens.map((token) => token.text).join(' '),
      tokens,
    };
  });
}

function countKeywords(transcript: Transcript): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of transcript.words) {
    const normalized = normalizeWord(word.text);
    if (normalized.length < 3 || isStopWord(normalized)) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return counts;
}

/**
 * Wrap a cue's text into at most `maxLines` lines of `maxCharsPerLine`,
 * balancing line lengths. Greedy wrapping leaves an orphan word on line two,
 * which looks careless at 64px.
 */
export function wrapCue(text: string, style: CaptionStyle): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const maxChars = style.maxCharsPerLine;
  const totalChars = text.length;
  const estimatedLines = clamp(Math.ceil(totalChars / maxChars), 1, style.maxLines);
  const targetPerLine = Math.ceil(totalChars / estimatedLines);

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && candidate.length > targetPerLine && lines.length < estimatedLines - 1) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);

  return lines.slice(0, style.maxLines);
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export function toSrt(cues: CaptionCue[]): string {
  return (
    cues
      .map(
        (cue) =>
          `${cue.index}\n${formatSrtTimecode(cue.start)} --> ${formatSrtTimecode(cue.end)}\n${cue.text}`,
      )
      .join('\n\n') + '\n'
  );
}

export function toVtt(cues: CaptionCue[]): string {
  const body = cues
    .map(
      (cue) =>
        `${cue.index}\n${formatTimecode(cue.start)} --> ${formatTimecode(cue.end)}\n${cue.text}`,
    )
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

/** `#RRGGBB` → ASS `&HAABBGGRR`. ASS stores colours reversed with an alpha byte. */
export function toAssColor(hex: string, alpha = 0): string {
  const clean = hex.replace('#', '').padEnd(6, '0');
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  const a = Math.round(clamp(alpha, 0, 1) * 255)
    .toString(16)
    .padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/**
 * Render cues as an ASS subtitle file for burn-in.
 *
 * ASS is the only widely-supported format that can express per-word timing and
 * transforms, which is what the "animated captions" look actually requires.
 * `\k` gives karaoke fills; `\t` gives the pop/slide transforms.
 */
export function toAss(
  cues: CaptionCue[],
  style: CaptionStyle,
  frame: { width: number; height: number },
): string {
  const marginV = Math.round(frame.height * (1 - style.positionY));

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${frame.width}`,
    `PlayResY: ${frame.height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    [
      'Style: Phantom',
      style.fontFamily,
      style.fontSizePx,
      toAssColor(style.primaryColor),
      toAssColor(style.highlightColor),
      toAssColor(style.outlineColor),
      toAssColor('#000000', 0.4),
      style.bold ? -1 : 0,
      0,
      0,
      0,
      100,
      100,
      0,
      0,
      1,
      style.outlineWidth,
      style.shadow,
      2, // bottom-centre alignment
      Math.round(frame.width * 0.06),
      Math.round(frame.width * 0.06),
      marginV,
      1,
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const events = cues.map((cue) => {
    const text = renderAssCueText(cue, style);
    return `Dialogue: 0,${formatAssTimecode(cue.start)},${formatAssTimecode(cue.end)},Phantom,,0,0,0,,${text}`;
  });

  return `${header}\n${events.join('\n')}\n`;
}

/** Build the inline-override string for one cue, including per-word animation. */
export function renderAssCueText(cue: CaptionCue, style: CaptionStyle): string {
  const highlight = toAssColor(style.highlightColor);
  const primary = toAssColor(style.primaryColor);

  const parts = cue.tokens.map((token) => {
    const text = escapeAss(style.uppercase ? token.text.toUpperCase() : token.text);

    switch (style.animation) {
      case 'karaoke': {
        // \k durations are in centiseconds and fill left-to-right as spoken.
        const centiseconds = Math.max(1, Math.round((token.end - token.start) * 100));
        const color = token.highlight ? `{\\c${highlight}}` : `{\\c${primary}}`;
        return `{\\k${centiseconds}}${color}${text}`;
      }
      case 'pop': {
        const color = token.highlight ? `{\\c${highlight}}` : '';
        const delay = Math.max(0, Math.round((token.start - cue.start) * 1000));
        return `{\\t(${delay},${delay + 120},\\fscx115\\fscy115)\\t(${delay + 120},${
          delay + 220
        },\\fscx100\\fscy100)}${color}${text}`;
      }
      case 'slide-up': {
        const delay = Math.max(0, Math.round((token.start - cue.start) * 1000));
        const color = token.highlight ? `{\\c${highlight}}` : '';
        return `{\\t(${delay},${delay + 160},\\frz0)\\move(0,20,0,0)}${color}${text}`;
      }
      case 'typewriter': {
        const delay = Math.max(0, Math.round((token.start - cue.start) * 1000));
        return `{\\alpha&HFF&\\t(${delay},${delay + 1},\\alpha&H00&)}${
          token.highlight ? `{\\c${highlight}}` : ''
        }${text}`;
      }
      case 'fade':
        return `${token.highlight ? `{\\c${highlight}}` : ''}${text}`;
      case 'none':
      default:
        return `${token.highlight ? `{\\c${highlight}}` : `{\\c${primary}}`}${text}`;
    }
  });

  const lines = wrapTokensToLines(parts, cue, style);
  const prefix = style.animation === 'fade' ? '{\\fad(120,120)}' : '';
  return prefix + lines.join('\\N');
}

/** Distribute already-rendered tokens across lines using the plain-text wrap. */
function wrapTokensToLines(parts: string[], cue: CaptionCue, style: CaptionStyle): string[] {
  const plainLines = wrapCue(cue.tokens.map((t) => t.text).join(' '), style);
  if (plainLines.length <= 1) return [parts.join(' ')];

  const lines: string[] = [];
  let cursor = 0;
  for (const line of plainLines) {
    const count = line.split(/\s+/).filter(Boolean).length;
    lines.push(parts.slice(cursor, cursor + count).join(' '));
    cursor += count;
  }
  if (cursor < parts.length) {
    lines[lines.length - 1] += ` ${parts.slice(cursor).join(' ')}`;
  }
  return lines;
}

function escapeAss(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

/** Shift and re-index cues after the cut plan changes the timeline. */
export function retimeCues(
  cues: CaptionCue[],
  map: (time: number) => number | null,
): CaptionCue[] {
  const result: CaptionCue[] = [];

  for (const cue of cues) {
    const start = map(cue.start);
    const end = map(cue.end);
    if (start === null || end === null || end <= start) continue;

    const tokens = cue.tokens
      .map((token) => {
        const tokenStart = map(token.start);
        const tokenEnd = map(token.end);
        if (tokenStart === null || tokenEnd === null) return null;
        return { ...token, start: tokenStart, end: Math.max(tokenEnd, tokenStart + 0.02) };
      })
      .filter((token): token is CaptionToken => token !== null);

    if (tokens.length === 0) continue;

    result.push({
      index: result.length + 1,
      start: round(start),
      end: round(end),
      text: tokens.map((t) => t.text).join(' '),
      tokens,
    });
  }

  return result;
}
