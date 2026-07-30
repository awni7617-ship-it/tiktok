# Phantom

AI content studio for short-form video. Upload a raw recording or start from a
prompt; Phantom cuts it, captions it, reframes it for vertical, cleans the
audio, tells you what would make it perform better, and schedules it to the
platforms you have connected — with every decision visible and reversible.

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npx prisma migrate dev
npm run db:seed
npm run dev          # web app on :3000
npm run worker       # background processing, in a second terminal
```

**No API keys are needed to run it.** Every AI capability falls back to a
deterministic offline provider that produces real output — parseable scripts, a
genuine WAV, a genuine PNG — so the whole pipeline works before you configure
anything. `/settings` shows which provider is actually serving each capability.

---

## What it does

| Area | What is implemented |
|---|---|
| **AI editor** | Silence and filler removal, false-start detection, pacing retiming, engagement scoring, clip variations, auto-reframe with subject tracking, animated captions, measurement-driven audio and video cleanup |
| **Render pipeline** | ffmpeg filter-graph compiler, trim/concat with retiming, animated crop, motion, burned-in ASS captions, sidechain-ducked music, multi-preset export |
| **Content generator** | Prompt or script → title, hook, script, scenes, B-roll queries, description, hashtags, CTA and thumbnail concepts, across 16 content types |
| **Faceless studio** | AI narration with voice selection, stock/generated visuals, scene timeline |
| **Viral optimizer** | Explainable rules over the real measurements, plus an AI review pass; every suggestion carries its evidence and can be applied, edited or dismissed |
| **Publishing** | OAuth 2.0 + PKCE connections, encrypted token storage, per-platform validation, upload adapters for TikTok, YouTube, Instagram and Facebook |
| **Planner** | Drag-and-drop calendar, queue management, posting-time recommendations, cadence analysis |
| **Analytics** | Aggregation, period comparison, retention curves with drop-off detection, top-performer ranking, AI summaries |
| **Collaboration** | Workspaces, five roles with server-enforced permissions, timeline-anchored comments, version snapshots, templates, brand kits |

### Deliberately not finished

Being straight about the edges, since the surface is large:

- **ASR/TTS/image providers**: OpenAI-compatible transcription, speech and image
  generation are implemented. Deepgram and ElevenLabs are configurable but fall
  back to the mock — the interfaces are there, the clients are not written.
- **Publishing adapters**: TikTok, YouTube, Instagram and Facebook are
  implemented end to end. LinkedIn, Pinterest and X have full OAuth definitions
  and validation rules but no upload adapter yet; `getAdapter` refuses them with
  a clear message rather than failing mid-publish.
- **ROI detection** uses a synthetic subject track. The `RoiDetector` interface
  is what a real face detector plugs into; the reframe *planner* it feeds is
  complete and tested.
- **Auth UI**: sessions, password hashing, RBAC and guards are implemented and
  tested; the login/signup screens are not built, so the UI runs against demo
  data rather than a signed-in session.
- **Analytics sync** writes real metric rows from the platform APIs, but the
  dashboards currently read a seeded demo dataset.

Everything above is behind an interface with a working implementation on the
other side, so none of it is a rewrite — but none of it should be mistaken for
done.

---

## Architecture

```
Browser ──▶ Next.js (App Router)
              ├── React Server Components — pages, data loading
              ├── Route handlers — validated JSON API
              └── enqueue ──▶ Postgres job queue
                                    │
                             Worker process
                                    ├── ASR / loudness analysis / ROI detection
                                    ├── Edit planning (pure, synchronous)
                                    ├── ffmpeg render
                                    └── Publish + metric sync
```

The organising principle is that **the creative logic is pure**. Silence
detection, cut planning, pacing, moment scoring, reframing, caption building
and the optimizer are all synchronous functions over plain data, with no I/O.
Everything expensive — transcription, loudness measurement, detection — happens
upstream and arrives as arguments.

That has three consequences worth the constraint:

1. The entire creative pipeline is testable in milliseconds without ffmpeg, a
   database, or a network.
2. Re-running with different settings never repeats the expensive work.
3. The UI can render the *actual* engine output rather than a mock of it — the
   editor screen calls the same `buildEditPlan` the worker does.

### Layout

```
src/
  app/                    Routes, pages and the JSON API
  components/             Design system, charts, editor, planner
  lib/                    Shared types and pure helpers (client-safe)
  server/
    edit/                 The AI editor. Pure. Heavily tested.
    video/                ffmpeg filter-graph compiler and render pipeline
    ai/                   Provider interfaces + Anthropic, OpenAI and mock
    optimizer/            Rules engine and AI review
    social/               Platform registry, OAuth, publish adapters
    planner/              Posting times and cadence
    analytics/            Aggregation and insights
    jobs/                 Queue, handlers and worker
    auth/ security/       Sessions, RBAC, crypto, rate limiting
    storage/              Local and S3-compatible drivers
prisma/schema.prisma      Data model
tests/                    208 tests
```

---

## Design decisions worth knowing

**Silence detection intersects two sources.** The loudness envelope and the
transcript gaps must *both* agree a region is empty before it is cut. Using
either alone is what makes automatic editors delete a quietly delivered line.

**Filler removal separates two classes.** Disfluencies (`um`, `uh`) are cut on
sight. Discourse markers (`like`, `so`) are only cut at a clause boundary with a
surrounding pause, because "I like this" must never lose its verb.

**Auto-reframe uses a damped follow with a dead zone.** A crop that snaps to
every detection jitters unwatchably. Small movements are ignored, large ones are
eased onto, and a big jump is treated as a scene cut and teleported rather than
whip-panned.

**Cut plans carry confidence, and users carry a veto.** High-confidence cuts
apply automatically, low-confidence ones are shown as suggestions, and an
explicit user decision always wins. An over-cut budget refuses to remove more
than 60% of the source, because a 90-second take collapsing to 8 seconds is a
detector failure, not a good edit.

**Publishing is the highest-consequence action, so it is the most constrained.**
Editors can schedule; only owners and admins can publish. Tokens are encrypted
with AES-256-GCM and never returned to the browser. Nothing is retried silently.

**Charts are hand-rolled SVG with a validated palette.** The categorical hues
were checked for lightness band, chroma, colour-blind separation and surface
contrast in both themes. Two light-mode slots fall under 3:1, so every
categorical chart ships direct labels *and* a table view rather than relying on
colour alone.

---

## Commands

```bash
npm run dev           # Next.js dev server
npm run worker:dev    # worker with reload
npm run verify        # typecheck + lint + test
npm run test          # 208 tests
npm run build         # production build
npm run db:migrate    # apply migrations
npm run db:seed       # demo workspace and users
```

## Configuration

See `.env.example` — every value is documented there. The only required one is
`DATABASE_URL`. In production the app refuses to start while `SESSION_SECRET` or
`ENCRYPTION_KEY` are still the development placeholders.

Social platforms stay disabled in the UI until both of their credentials are
set; the redirect URI is always `{APP_URL}/api/social/{platform}/callback`.

## Deploying

```bash
docker compose up --build          # web + worker + postgres
docker compose up --scale worker=4 # more render capacity
```

The same image runs both roles — `npm start` for the web app, `npm run worker`
for processing — so the two can never drift apart. `/api/health` reports each
dependency separately: the app is genuinely usable without ffmpeg (everything
but rendering) and without AI keys (offline providers), so only the database
failing marks it unhealthy.
