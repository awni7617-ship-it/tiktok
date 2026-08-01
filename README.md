# Phantom

Describe an idea, get a finished vertical video. Phantom writes the script,
narrates it, illustrates it, cuts it together with motion and captions, and
saves the `.mp4` on your machine — no account, no database, no setup.

## Download it

**[Get the app →](../../releases/latest)**

| Your computer | File |
|---|---|
| Windows | `Phantom-Setup-*.exe` |
| Mac | `Phantom-*.dmg` — arm64 for Apple Silicon, x64 for Intel |
| Linux | `Phantom-*.AppImage` |

Download, open, use it. No Node, no terminal, no database. The build is not
code-signed, so the first launch needs **More info → Run anyway** on Windows
or **right-click → Open** on macOS.

**Updates.** The app checks for a newer build on launch and every six hours.
When one exists it says so — a notification, then a dialog — and clicking
Download fetches the right installer for your machine inside the app, with
progress on the dock or taskbar icon. The file is checked against its
published SHA-256 before being offered, and a mismatch deletes it rather than
handing you something to run. *Help → Check for Updates…* asks on demand.

The final install is the OS installer, not a silent swap: these builds are
unsigned, and a silent self-replacement would be an unsigned binary
installing itself with nothing visible to the user. Signing the builds is
what would make that step disappear.

Also published there: `phantom-editor-<version>.zip`, the same app without a
window — a portable server for running it headless or on a machine that
should not have a GUI:

```bash
unzip phantom-editor-*.zip && cd phantom-editor
./start.sh                    # http://localhost:3000
```

That build needs Node 20.11+ and nothing else — ffmpeg is bundled with it, so
rendering works out of the box.

Build either yourself: `npm run package:editor` (server bundle) or
`npm run desktop:build` (installer for your OS).

## Run from source

```bash
npm install
npm run dev          # http://localhost:3000
```

**No API keys are needed to run it.** Every AI capability falls back to a
deterministic offline provider that produces real output — parseable scripts, a
genuine WAV, a genuine PNG — so the whole pipeline works before you configure
anything. `/settings` shows which provider is actually serving each capability.

---

## What it does

Three screens, because there are three things it does:

| Screen | What it does |
|---|---|
| **Make a video** | Describe an idea → script, narration, visuals, captions, and a finished vertical `.mp4`. Or stop after the script and edit it first. |
| **Your videos** | Everything you have made, saved on your own machine. Play, download, delete. Survives restarts with no database. |
| **Settings** | Which AI provider is serving each capability, and what to set to change it. |

Under the hood that is: an AI content generator across 16 niches, a text-to-speech
narrator, an image generator, and an ffmpeg compiler that lays stills onto a
vertical timeline with Ken Burns motion, crossfades, burned-in captions and a
ducked music bed — all timed to the measured length of the narration.

**ffmpeg ships inside the desktop app**, so making a video needs nothing
installed.

### What was removed, and why

The app used to have eight screens: a dashboard, projects, a planner, a
publishing queue, analytics and a team page. They rendered convincing data
that was seeded demo content — none of it was yours, and none of it updated.
A menu full of screens that do not work is indistinguishable from an app where
nothing works, so they are gone.

The engines behind them are not. Silence and filler detection, cut planning,
auto-reframe, the viral optimizer, the publishing adapters, the scheduler and
the analytics aggregation are all still here, tested, and waiting on wiring to real
data rather than a seed file. They come back one at a time, each when it does
something real.

### Getting good output

Out of the box everything runs on offline stand-ins: template scripts,
synthetic tone for narration, gradients for visuals. That is why untouched
output looks generic — it is a working pipeline with placeholder intelligence
in it.

**Settings → AI keys** changes that, in the app, with no restart:

| Key | What it does |
|---|---|
| Anthropic | Claude writes the script, hook, scenes and metadata |
| OpenAI | `gpt-image-1` makes the visuals, `tts-1-hd` speaks the narration |

Keys are stored in the app's own data folder with `0600` permissions, never
sent to the browser, and never leave your machine except to the provider.

The models are also *told what they are writing for*: that each scene becomes
one still image with a slow push-in, that captions are burned in from the
narration word for word, that there is no live action or camera movement, and
that the image model must render no text. Without that brief a script model
writes "cut to a montage of the 1970s" — a direction nothing in the pipeline
can render — and the image model bakes garbled words into a frame that
already has captions over it.
- **Nothing is published anywhere.** Connecting a social account and posting
  is implemented in the server but not reachable from these three screens.

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
  app/                    Three screens and the JSON API
  components/             Design system, studio, video library
  lib/                    Shared types and pure helpers (client-safe)
  server/
    studio/               Idea → finished video: compiler, orchestrator, library
    edit/                 The AI editor engines. Pure. Heavily tested.
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
tests/                    248 tests
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

### Docker (self-hosted)

```bash
docker compose up --build          # web + worker + postgres
docker compose up --scale worker=4 # more render capacity
```

The same image runs both roles — `npm start` for the web app, `npm run worker`
for processing — so the two can never drift apart. `/api/health` reports each
dependency separately: the app is genuinely usable without ffmpeg (everything
but rendering) and without AI keys (offline providers), so only the database
failing marks it unhealthy.

### Cloudflare

**Auto-deploy (recommended).** Add one GitHub secret — `CLOUDFLARE_API_TOKEN`,
from the *Edit Cloudflare Workers* template at
[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
— and `.github/workflows/deploy-cloudflare.yml` builds and deploys on every
push, creating the R2 bucket and syncing secrets as it goes. Nothing to
configure in the Cloudflare dashboard.

**Or from your machine:**

```bash
npx wrangler login
npm run cf:setup     # creates the R2 bucket, names any missing secret
npm run cf:deploy    # Worker + R2
```

Deploying from the **Cloudflare dashboard** (connect-to-Git) instead? Choose
*Workers*, not Pages, and set the deploy command to **`npm run cf:deploy:ci`**
— it builds the Worker bundle and deploys it in one step. The default
`npx wrangler deploy` fails with *"Could not find compiled Open Next config"*,
because it expects a build step that produced `.open-next/`. Full field list in
[docs/cloudflare.md](docs/cloudflare.md).

`cf:setup` is a preflight: it checks the resources the config references
before a build is spent on them, and prints the exact command for whatever is
missing. It runs again as part of `cf:deploy`.

Rendering **cannot** run in a Worker — ffmpeg is a native binary — so the base
config ships with it disabled and the health endpoint says so. To enable it,
either deploy the container config (`npm run cf:deploy:full`, which adds
Hyperdrive, a Cloudflare Container running the same worker loop, and a cron
trigger) or run `npm run worker` anywhere that has ffmpeg, against the same
Postgres and R2.

The runtime is detected at execution time, so this is one codebase, not a
Cloudflare fork. Full setup, costs and limitations: **[docs/cloudflare.md](docs/cloudflare.md)**.
