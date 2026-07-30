import type { ContentNiche } from './types';

/**
 * The content types the generator supports.
 *
 * Kept in `lib` so the studio's client-side picker can import it without
 * pulling the server-only schema module (and its Node dependencies) into the
 * browser bundle.
 */
export const NICHES = [
  'scary-story',
  'mystery',
  'reddit-story',
  'educational',
  'motivational',
  'gaming',
  'football',
  'history',
  'finance',
  'business',
  'technology',
  'science',
  'documentary',
  'product-review',
  'news-summary',
  'storytelling',
] as const satisfies readonly ContentNiche[];

export const NICHE_LABELS: Record<ContentNiche, string> = {
  'scary-story': 'Scary story',
  mystery: 'Mystery',
  'reddit-story': 'Reddit story',
  educational: 'Educational',
  motivational: 'Motivational',
  gaming: 'Gaming',
  football: 'Football',
  history: 'History',
  finance: 'Finance',
  business: 'Business',
  technology: 'Technology',
  science: 'Science',
  documentary: 'Documentary',
  'product-review': 'Product review',
  'news-summary': 'News summary',
  storytelling: 'Storytelling',
};
