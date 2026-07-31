import { defineCloudflareConfig } from '@opennextjs/cloudflare';

/**
 * OpenNext configuration.
 *
 * Left at the defaults deliberately. Phantom's pages are either static shells
 * or per-request dynamic renders backed by the database, so there is nothing
 * meaningful for an incremental cache to hold — adding a KV or R2 cache here
 * would buy complexity and no hit rate.
 *
 * If ISR pages are introduced later, this is where the incremental cache and
 * tag cache get wired up:
 * https://opennext.js.org/cloudflare/caching
 */
export default defineCloudflareConfig();
