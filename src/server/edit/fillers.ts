import type { Cut, Transcript, TranscriptWord } from '@/lib/types';
import { normalizeWord } from '@/lib/text';

/**
 * Filler-word removal.
 *
 * Two classes of filler are handled differently because the failure modes
 * differ. Standalone disfluencies ("um", "uh") are almost always safe to cut.
 * Discourse markers ("like", "so", "basically") are only filler in some
 * positions — "I like this" must never lose its verb — so those require the
 * word to sit at a clause boundary *and* be bracketed by a pause.
 */

/** Disfluencies with no lexical meaning. Safe to remove on sight. */
const HARD_FILLERS = new Set([
  'um', 'uh', 'umm', 'uhh', 'erm', 'er', 'ah', 'ahh', 'eh', 'hmm', 'hm', 'mm',
  'mhm', 'uhm', 'huh',
]);

/** Words that are filler only when used as a discourse marker. */
const SOFT_FILLERS = new Set([
  'like', 'literally', 'basically', 'actually', 'honestly', 'obviously',
  'essentially', 'anyway', 'anyways', 'right', 'okay', 'ok', 'well', 'so',
  'just', 'really', 'kinda', 'sorta',
]);

/** Multi-word filler phrases, matched greedily against the word stream. */
const FILLER_PHRASES: string[][] = [
  ['you', 'know'],
  ['i', 'mean'],
  ['sort', 'of'],
  ['kind', 'of'],
  ['or', 'something'],
  ['or', 'whatever'],
  ['if', 'that', 'makes', 'sense'],
  ['does', 'that', 'make', 'sense'],
  ['at', 'the', 'end', 'of', 'the', 'day'],
];

export interface FillerOptions {
  /** Remove standalone disfluencies such as "um". */
  removeHardFillers: boolean;
  /** Remove discourse markers when they sit at a clause boundary. */
  removeSoftFillers: boolean;
  /** Remove multi-word filler phrases such as "you know". */
  removePhrases: boolean;
  /** Silence on either side, in seconds, that makes a soft filler removable. */
  softFillerPauseSec: number;
  /** Ignore ASR tokens below this confidence — a misheard word is not a filler. */
  minConfidence: number;
}

export const DEFAULT_FILLER_OPTIONS: FillerOptions = {
  removeHardFillers: true,
  removeSoftFillers: false,
  removePhrases: true,
  softFillerPauseSec: 0.18,
  minConfidence: 0.5,
};

export function isHardFiller(word: string): boolean {
  return HARD_FILLERS.has(normalizeWord(word));
}

export function isSoftFiller(word: string): boolean {
  return SOFT_FILLERS.has(normalizeWord(word));
}

/**
 * A soft filler is only removable when dropping it cannot change the sentence's
 * meaning. We approximate that with two syntactic proxies: it must start a
 * clause (sentence start, or right after terminal//comma punctuation), and it
 * must be surrounded by enough dead air that the speaker was clearly stalling.
 */
function isSoftFillerRemovable(
  words: TranscriptWord[],
  index: number,
  pauseSec: number,
): boolean {
  const word = words[index];
  if (!word) return false;

  const previous = words[index - 1];
  const next = words[index + 1];

  const atClauseStart = !previous || /[.!?,;:—-]$/.test(previous.text.trim());
  if (!atClauseStart) return false;

  const gapBefore = previous ? word.start - previous.end : Number.POSITIVE_INFINITY;
  const gapAfter = next ? next.start - word.end : Number.POSITIVE_INFINITY;

  // Stalling shows up as dead air on at least one side of the marker.
  return gapBefore >= pauseSec || gapAfter >= pauseSec;
}

function matchPhraseAt(words: TranscriptWord[], index: number, phrase: string[]): boolean {
  if (index + phrase.length > words.length) return false;
  for (let i = 0; i < phrase.length; i++) {
    const word = words[index + i];
    if (!word || normalizeWord(word.text) !== phrase[i]) return false;
    // A long pause inside a phrase means these words are not one unit.
    if (i > 0) {
      const previous = words[index + i - 1]!;
      if (word.start - previous.end > 0.4) return false;
    }
  }
  return true;
}

/**
 * Find every filler region in the transcript.
 *
 * Cuts are returned in source order and never overlap: phrase matches are
 * greedy and consume their words, so "you know, like" yields one phrase cut
 * plus one soft-filler cut rather than three overlapping ones.
 */
export function detectFillers(
  transcript: Transcript,
  options: Partial<FillerOptions> = {},
): Cut[] {
  const opts = { ...DEFAULT_FILLER_OPTIONS, ...options };
  const words = transcript.words;
  const cuts: Cut[] = [];
  let index = 0;

  while (index < words.length) {
    const word = words[index]!;

    if (word.confidence < opts.minConfidence) {
      index += 1;
      continue;
    }

    if (opts.removePhrases) {
      const phrase = FILLER_PHRASES.find((candidate) => matchPhraseAt(words, index, candidate));
      if (phrase) {
        const last = words[index + phrase.length - 1]!;
        cuts.push({
          start: word.start,
          end: last.end,
          reason: 'filler',
          confidence: 0.72,
          note: `Filler phrase "${phrase.join(' ')}"`,
        });
        index += phrase.length;
        continue;
      }
    }

    if (opts.removeHardFillers && isHardFiller(word.text)) {
      cuts.push({
        start: word.start,
        end: word.end,
        reason: 'filler',
        confidence: 0.95,
        note: `Disfluency "${word.text.trim()}"`,
      });
      index += 1;
      continue;
    }

    if (
      opts.removeSoftFillers &&
      isSoftFiller(word.text) &&
      isSoftFillerRemovable(words, index, opts.softFillerPauseSec)
    ) {
      cuts.push({
        start: word.start,
        end: word.end,
        reason: 'filler',
        confidence: 0.6,
        note: `Discourse marker "${word.text.trim()}" at a clause boundary`,
      });
      index += 1;
      continue;
    }

    index += 1;
  }

  return cuts;
}

/**
 * Detect false starts and stutters: a short run of words immediately repeated,
 * or a fragment abandoned mid-sentence and restarted. Only the *first*
 * occurrence is cut, so the clean take survives.
 */
export function detectFalseStarts(transcript: Transcript, maxRunLength = 4): Cut[] {
  const words = transcript.words;
  const cuts: Cut[] = [];
  let index = 0;

  while (index < words.length) {
    let matched = false;

    // Try the longest repeated run first so "I want to, I want to" is one cut.
    for (let run = maxRunLength; run >= 1 && !matched; run--) {
      if (index + run * 2 > words.length) continue;

      let identical = true;
      for (let i = 0; i < run; i++) {
        const first = words[index + i]!;
        const second = words[index + run + i]!;
        if (normalizeWord(first.text) !== normalizeWord(second.text)) {
          identical = false;
          break;
        }
      }
      if (!identical) continue;

      const firstStart = words[index]!;
      const firstEnd = words[index + run - 1]!;
      const secondStart = words[index + run]!;

      // A deliberate rhetorical repeat has a beat between the two halves;
      // a stutter runs straight through.
      if (secondStart.start - firstEnd.end > 0.6) continue;

      cuts.push({
        start: firstStart.start,
        end: secondStart.start,
        reason: run === 1 ? 'repetition' : 'false-start',
        confidence: run === 1 ? 0.7 : 0.82,
        note:
          run === 1
            ? `Stutter on "${normalizeWord(firstStart.text)}"`
            : `Restarted phrase "${words
                .slice(index, index + run)
                .map((w) => w.text.trim())
                .join(' ')}"`,
      });
      index += run;
      matched = true;
    }

    if (!matched) index += 1;
  }

  return cuts;
}
