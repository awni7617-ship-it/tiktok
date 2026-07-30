/** Text helpers shared by the caption builder, optimizer and content generator. */

/** Strip punctuation and casing so tokens can be compared as words. */
export function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, '');
}

export function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export function wordCount(text: string): number {
  return words(text).length;
}

/**
 * Estimate spoken duration. 150 wpm is a natural narration pace for short-form;
 * punctuation adds the pauses a flat wpm figure misses.
 */
export function estimateSpeechDuration(text: string, wordsPerMinute = 150): number {
  const count = wordCount(text);
  const base = (count / wordsPerMinute) * 60;
  const sentencePauses = (text.match(/[.!?]/g)?.length ?? 0) * 0.35;
  const commaPauses = (text.match(/[,;:]/g)?.length ?? 0) * 0.15;
  return Math.round((base + sentencePauses + commaPauses) * 100) / 100;
}

export function truncate(text: string, maxChars: number, ellipsis = '…'): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, Math.max(0, maxChars - ellipsis.length));
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice;
  return cut.trimEnd() + ellipsis;
}

export function titleCase(text: string): string {
  const minor = new Set([
    'a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'on', 'at', 'to',
    'from', 'by', 'of', 'in', 'with', 'as', 'is', 'it',
  ]);
  return text
    .split(/\s+/)
    .map((word, index, all) => {
      const lower = word.toLowerCase();
      if (index !== 0 && index !== all.length - 1 && minor.has(lower)) return lower;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Normalize a hashtag to `#lowercasealphanumeric`, dropping empties. */
export function normalizeHashtag(tag: string): string | null {
  const cleaned = tag
    .replace(/^#+/, '')
    .replace(/[^\p{L}\p{N}_]/gu, '')
    .toLowerCase();
  return cleaned.length > 0 ? `#${cleaned}` : null;
}

export function dedupeHashtags(tags: string[], limit = 30): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const normalized = normalizeHashtag(tag);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

/** Split prose into sentences, keeping terminal punctuation attached. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'“])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'so', 'because', 'as', 'of',
  'at', 'by', 'for', 'with', 'about', 'into', 'through', 'to', 'from', 'in', 'on',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did',
  'have', 'has', 'had', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him',
  'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their', 'this', 'that',
  'these', 'those', 'there', 'here', 'what', 'which', 'who', 'when', 'where', 'how',
  'not', 'no', 'just', 'very', 'really', 'get', 'got', 'up', 'out', 'down', 'over',
  'can', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 's', 't', 're',
]);

export function isStopWord(word: string): boolean {
  return STOP_WORDS.has(normalizeWord(word));
}

/**
 * Rank the most information-bearing words by term frequency, ignoring stop words.
 * Used to pick which caption tokens get the highlight treatment.
 */
export function keywordFrequencies(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of words(text)) {
    const word = normalizeWord(raw);
    if (word.length < 3 || isStopWord(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

export function topKeywords(text: string, limit = 12): string[] {
  return [...keywordFrequencies(text).entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}
