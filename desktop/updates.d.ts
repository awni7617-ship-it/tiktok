export interface VersionInfo {
  version: string;
  publishedAt: string | null;
  notes: string | null;
}

export type UpdateCheck =
  | { status: 'update'; latest: VersionInfo; releasesUrl: string }
  | { status: 'current'; latest: VersionInfo }
  | { status: 'unknown'; reason: string };

export declare function compareVersions(a: unknown, b: unknown): number;
export declare function isNewer(current: string, candidate: string): boolean;
export declare function parseVersionInfo(text: string): VersionInfo | null;
export declare function checkForUpdate(options?: {
  currentVersion?: string;
  fetchImpl?: typeof fetch;
  url?: string;
  timeoutMs?: number;
}): Promise<UpdateCheck>;
export declare function assetNameFor(options: {
  platform?: string;
  arch?: string;
  version: string;
}): string;
export declare function parseChecksums(text: string): Map<string, string>;
export declare function downloadUpdate(options: {
  version: string;
  targetDir: string;
  platform?: string;
  arch?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (fraction: number) => void;
  base?: string;
  checksumsUrl?: string;
}): Promise<{ path: string; asset: string; bytes: number }>;

export declare const VERSION_URL: string;
export declare const CHECKSUMS_URL: string;
export declare const DOWNLOAD_BASE: string;
export declare const RELEASES_URL: string;
