import type { PlatformId, SocialAccount } from '@/lib/types';

export interface PublishRequest {
  /** Absolute path to the finished mp4. */
  file: string;
  title: string;
  caption: string;
  hashtags: string[];
  account: SocialAccount;
}

export interface PublishResult {
  /** The platform's own id for the post. */
  remoteId: string;
  /** Public URL, when the platform returns or allows deriving one. */
  url: string | null;
}

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
}

export interface PlatformAdapter {
  readonly id: PlatformId;
  readonly name: string;
  /** Scopes requested during the OAuth handshake. */
  readonly scopes: string[];
  authorizeUrl(app: OAuthApp, redirectUri: string, state: string): string;
  exchangeCode(app: OAuthApp, code: string, redirectUri: string): Promise<SocialAccount>;
  refresh(app: OAuthApp, account: SocialAccount): Promise<SocialAccount>;
  publish(request: PublishRequest): Promise<PublishResult>;
}

/** Composed post text. Platforms differ on where hashtags belong; they do not. */
export function composeCaption(caption: string, hashtags: string[]): string {
  const tags = hashtags.map((t) => `#${t.replace(/^#+/, '')}`).join(' ');
  return tags ? `${caption}\n\n${tags}` : caption;
}

export class PublishError extends Error {
  constructor(
    message: string,
    /** True when retrying later could plausibly work. */
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

/** Read an API error body without assuming its shape. */
export async function describeError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const error = body.error;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const record = error as Record<string, unknown>;
      const message = record.message ?? record.error_description ?? record.code;
      if (typeof message === 'string') return message;
    }
    const message = body.message ?? body.error_description;
    if (typeof message === 'string') return message;
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return (await response.text().catch(() => '')).slice(0, 300);
  }
}
