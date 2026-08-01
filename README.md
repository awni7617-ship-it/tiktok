# Autoreel

Pick a niche. Autoreel writes the script, narrates it, illustrates it, cuts it
into a vertical video with captions and music, and posts it on a schedule.

Runs on your own machine. No account, no database, no subscription.

## Download it

**[Get the app →](../../releases/latest)**

| Your computer | File |
|---|---|
| Windows | `Autoreel-Setup-*.exe` |
| macOS | `Autoreel-*-arm64.dmg` (Apple Silicon) · `Autoreel-*-x64.dmg` (Intel) |
| Linux | `Autoreel-*.AppImage` |

Download, open, use it. No Node, no terminal. **ffmpeg is bundled**, so
rendering works with nothing installed, and the worker runs inside the app —
there is no second process to start.

The builds are not code-signed, so the first launch needs **More info → Run
anyway** on Windows or **right-click → Open** on macOS. Signing is what makes
that prompt go away and it needs paid certificates on both platforms.

Videos and settings live in the app's own data folder — *File → Open Data
Folder* shows you where.

## Or run from source

```bash
npm install
npm run dev      # http://localhost:3000
npm run worker   # in a second terminal — this is what renders
```

From source the worker is a separate process on purpose: a render that pegs a
core should not compete with the dev server's rebuilds. **Nothing renders
without it running.**

**No API keys are needed either way.** Every AI capability has an offline
stand-in that produces real output, so the whole pipeline works end to end
before you configure anything. Add keys in Settings when you want real scripts,
voice and visuals.

---

## How it works

You create a **channel**: a niche, an art style, a voice, a music bed and a
posting cadence. From then on the worker keeps it fed.

```
Autopilot                 Worker
  │                         │
  ├─ channel below depth?   │
  │    └─ pick an angle ────┼─▶ queue a video
  │                         │
  │                         ├─ script    (Claude, or a template)
  │                         ├─ narrate   (OpenAI TTS, or timed silence)
  │                         ├─ illustrate(gpt-image-1, or gradients)
  │                         └─ render    (ffmpeg)
  │                                        │
  └─ slot arrived? ─────────────────────────▶ publish
```

Three screens, because there are three things to do:

| Screen | What it does |
|---|---|
| **Channels** | Create and pause channels. See what is queued and when it posts. |
| **Videos** | Everything made, on this machine. Play, download, post, delete. |
| **Settings** | AI keys, connected accounts, and which provider is serving what. |

### What the renderer actually does

Each scene becomes one still image with a slow push-in, crossfaded into the
next, over a music bed ducked under the narration. Captions are burned in from
the narration word for word.

Everything is timed to the **measured** length of the voiceover, not an
estimate — narration is generated first precisely so the images and captions
can be cut to it.

### The model is told what it is writing for

The script prompt spells out that each scene becomes a single still image, that
there is no live action or camera movement, and that the image model must
render no text. Without that, a script model writes "cut to a sweeping aerial
montage" — which nothing in this pipeline can render — and the image model
bakes garbled lettering into a frame that already has captions over it.

---

## Getting good output

Out of the box everything runs on stand-ins, which is why untouched output
looks generic: it is a working pipeline with placeholder intelligence in it.

**Settings → AI keys** changes that, in the app, with no restart:

| Key | What it does |
|---|---|
| Anthropic | Claude writes the script, hook, scenes and caption |
| OpenAI | `gpt-image-1` draws the visuals, `tts-1-hd` speaks the narration |

Keys are stored in the data directory with `0600` permissions, never sent to
the browser, and never leave your machine except to the provider.

Without an OpenAI key the narration is **silent** — correctly timed to the
words, so captions and cuts still land, but no voice. That is deliberate:
synthesising speech without a model is not something a stand-in can honestly
fake, and a silent preview is unmistakably a preview.

---

## Publishing

The adapters for TikTok, Instagram and YouTube are fully implemented, and each
one needs an app you register with that platform before it will accept a post.
That is not a gap in this project — all three require a reviewed app, and no
shipped credential could change it.

See `.env.example` for what each platform needs. Once credentials are set and
you restart, **Settings → Accounts** offers a Connect button.

Three things worth knowing before you plan around this:

- **TikTok** posts arrive as private drafts until your app passes TikTok's
  audit.
- **YouTube** uploads are forced to `private` until your OAuth client is
  verified by Google.
- **Instagram** does not accept an uploaded file. It fetches the video over
  HTTP from a URL you provide, so `PUBLIC_BASE_URL` has to be reachable from
  the public internet. On a laptop with no such address, Instagram publishing
  cannot work at all. TikTok and YouTube take the bytes directly.

Tokens are refreshed automatically where the platform allows it. Nothing is
posted to an account you have not connected.

---

## Architecture

```
src/
  app/                  Three screens and the JSON API
  components/           Design system and the shared video row
  lib/                  Types, catalog and pure helpers (client-safe)
  server/
    ai/                 Provider interfaces + Anthropic, OpenAI and offline
    content/            Channels, idea selection, the produce pipeline
    video/              ffmpeg filter-graph compiler, captions, render
    schedule/           Cadence → posting slots. Pure.
    publish/            Platform adapters, OAuth and token handling
    jobs/               Queue, autopilot, handlers and the worker loop
    store/              JSON persistence and path resolution
tests/                  126 tests
```

Two decisions shape the rest:

**The creative logic is pure.** Caption timing, cadence arithmetic and the
entire ffmpeg filter graph are synchronous functions over plain data. The
hardest part of the renderer is a function from a timeline to argv, so it is
tested without ffmpeg installed — a broken graph fails an assertion on a
string instead of producing a corrupt mp4 twenty minutes into a render.

**There is no database.** A single-user app that makes a few videos a day does
not have a database's problems, and a database is the single biggest obstacle
to "clone it and run it". Persistence is JSON files written through a temp file
and `rename`, which is atomic — a reader sees the old file or the new one,
never half of one.

### Other decisions worth knowing

**Jobs are leased, not claimed.** A worker that dies mid-render leaves its
lease to expire and the job is picked up again. Retries back off, and a job
only retries when retrying could plausibly change the outcome — a missing
account will fail identically forever.

**Autopilot is idempotent.** It only ever tops up to the shortfall, so the
worker calling it every minute does not produce a video every minute.

**Videos are queued ahead of their slot,** because rendering takes minutes and
a video that starts generating at its posting time is already late.

**One platform failing does not block the others.** Each is attempted and
recorded independently, and a video that reached at least one platform is not
marked failed.

**Captions are a generated ASS file, not `drawtext`.** The widely used static
ffmpeg builds ship without freetype, so `drawtext` is simply absent; libass is
present far more often, handles wrapping and outlines properly, and needs one
filter instead of one per caption. If neither is available the video renders
without captions rather than not rendering.

---

## Commands

```bash
npm run dev            # Next.js dev server
npm run worker         # the render/publish loop — nothing happens without it
npm run worker:dev     # same, with reload
npm run verify         # typecheck + lint + test
npm run build          # production build

npm run desktop        # build the server bundle and run the Electron shell
npm run desktop:build  # installer for your platform, into release/
```

`desktop:build` produces an installer for whichever platform you run it on;
the release workflow runs all three on GitHub's runners.

`/api/health` reports each dependency separately. The app is genuinely usable
with pieces missing — without ffmpeg everything but rendering works, without
keys the offline providers serve — so only an unwritable data directory is
actually fatal.

## Configuration

See `.env.example`; every value is documented there and none is required.
