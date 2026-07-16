# Kid-Safe YouTube Whitelist App (webOS TV)

A private, sideloaded webOS TV app that plays only videos from channels/videos
you approve — no algorithm, no search, no suggestions. See
`kids-youtube-webos-plan.md` for the full design rationale.

## Prerequisites

- Node.js 18+ (for the refresh script)
- A Google account + a YouTube Data API v3 key
- A GitHub account (repo + Pages + Actions)
- An LG webOS TV in Developer Mode + `@webos-tools/cli`

## 1. Get a YouTube Data API key

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create (or reuse) a project, enable **YouTube Data API v3**.
3. Create an API key (Credentials → Create Credentials → API key).
4. Keep this key secret — it only needs to be used in the refresh script /
   GitHub Actions secret, never shipped to the TV.

## 2. Edit the whitelist

Edit `whitelist.json` at the repo root:

```json
{
  "channels": [
    { "channelId": "UCxxxxxxxx", "name": "Some Kids Channel", "maxVideos": 30 },
    { "handle": "@freeschool", "maxVideos": 30 }
  ],
  "collections": [
    { "name": "Toán: Số đến 20", "playlistId": "PL9swKX1PviEreEPMSNS5uA52jwQSpaSnc" }
  ],
  "individualVideos": [
    { "videoId": "abc123", "title": "One specific approved video" },
    { "url": "https://www.youtube.com/watch?v=XqZsoesa55w" }
  ]
}
```

`collections` are curated learning rows shown at the top of the home screen.
Each entry points at an existing public YouTube playlist (a bare `PL…` ID or a
pasted `playlist?list=…` URL in `playlistId` or `url`) — e.g. the official
Numberblocks COURSE level playlists. Playlist order is preserved (it's the
learning order), with no `maxVideos` cap. Note: you can't build your *own*
playlist for this — made-for-kids videos have Save-to-playlist disabled — so
point at the channel's existing playlists instead.

`individualVideos` entries take a bare video ID or any pasted YouTube URL
(`watch?v=`, `youtu.be/`, `shorts/`) in `videoId` or `url` — easiest workflow
is Share → Copy Link on your phone and paste it in. `title` is optional (the
real title is fetched).

Each channel entry needs either a `channelId` (the `UC…` ID) or a `handle` —
the easiest option, since it's right in the channel URL. `handle` accepts
`"@freeschool"`, `"freeschool"`, or a full URL like
`"https://www.youtube.com/@freeschool"` (a handle/URL pasted into the
`channelId` field also works). Handles are resolved via the API at refresh
time (1 quota unit each). `name` is optional for handle entries — the
channel's real title is used if omitted.

Prefer handles over hand-copied channel IDs: an ID with a typo silently
resolves to nothing, while a bad handle logs a clear warning. After editing,
run the refresh script and check its stderr summary — every channel should
report a kept-videos count; an unresolved channel logs a warning naming it.

## 3. Run the refresh script locally

```bash
YT_API_KEY=xxxxxxxxxxxxxxxx node scripts/refresh-cache.mjs
```

This reads `whitelist.json`, calls the YouTube Data API, and writes
`app/videos_cache.json`. It prints a per-channel kept/dropped summary and an
estimated quota-units-used total to stderr. A failing channel logs a warning
and is skipped — the script only exits non-zero (and skips writing the cache)
on total failure (e.g. missing API key, or zero usable videos across every
channel/video).

## 4. Test the app locally

Serve the `app/` directory with any static file server, e.g.:

```bash
npx serve app
# or
python3 -m http.server --directory app 8080
```

Then open the printed URL in a browser. (Note: YouTube IFrame embeds refuse
to play from `file://` — you must use an http(s) server, even locally.)

## 5. Deploy to GitHub Pages

**Pages layout used by this repo: serve from the repository root (branch
`main`, folder `/`).** GitHub Pages only supports serving from the repo root
or `/docs`, not an arbitrary folder — so the app is reachable at
`https://<username>.github.io/<repo>/app/` (note the `/app/` path segment).
This must match exactly in three places:

- `shell/index.html` — the `HOSTED_APP_URL` constant
- this README
- nowhere else needs to change (the workflow only writes `app/videos_cache.json`)

Steps:

1. Create a GitHub repo (e.g. `webos-yt-kids`) and push this project to it.
2. Repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch:
   `main`, folder: `/ (root)`. Save.
3. Repo → **Settings → Secrets and variables → Actions** → **New repository
   secret** → name `YT_API_KEY`, value = your API key from step 1.
4. Repo → **Settings → Actions → General** → ensure Actions are enabled.
5. Trigger the workflow once manually (Actions tab → "Refresh video cache" →
   Run workflow) to generate the initial `app/videos_cache.json`, or just run
   the script locally and commit the result.
6. Confirm the app loads at `https://<username>.github.io/<repo>/app/`.

The workflow (`.github/workflows/refresh-cache.yml`) runs daily at 06:00 UTC
and on manual dispatch; it commits `app/videos_cache.json` only if it
changed.

## 6. Edit the webOS shell URL

Open `shell/index.html` and change:

```js
var HOSTED_APP_URL = "https://YOUR-GH-USERNAME.github.io/webos-yt-kids/app/";
```

to your actual GitHub Pages URL from step 5 (keep the trailing `/app/`).

## 7. webOS TV setup + install

One-time Dev Mode setup:

1. On the TV: LG Content Store → install **Developer Mode** app.
2. Create a free LG Developer account at developer.lge.com.
3. In the Developer Mode app: sign in, toggle **Dev Mode Status** on (TV
   reboots), turn on the **Key Server**, note the passphrase.
4. On your PC: `npm install -g @webos-tools/cli`
5. Pair: `ares-setup-device` (enter TV IP + passphrase from step 3)
6. Confirm: `ares-device-info --device <tvname>`

Build, install, launch:

```bash
ares-package ./shell
ares-install --device <tvname> com.family.kidsyoutube_1.0.0_all.ipk
ares-launch --device <tvname> com.family.kidsyoutube
```

The `.ipk` only needs to be rebuilt/reinstalled if `shell/` changes (e.g. the
hosted URL). All UI and whitelist changes just require pushing to GitHub —
relaunch the app on the TV to pick them up.

## Maintenance

- **Dev Mode session** lasts ~1000 hours (~41 days). Open the Developer Mode
  app on the TV and tap **Extend** before it lapses, or all sideloaded apps
  get removed (reinstall via `ares-install`, no data loss — everything lives
  in this repo).
- Dev Mode also disables itself after **10 TV reboots with no network
  connection**.
- **TV firmware updates uninstall sideloaded apps.** Reinstall is just the
  2-command `ares-install` + `ares-launch` above (re-pairing via
  `ares-setup-device` may be needed first).
- **Whitelist updates:** edit `whitelist.json`, push. The next daily cron run
  (or a manual "Run workflow" dispatch) refreshes `app/videos_cache.json`.
  No TV-side action needed.

## Repo layout

```
whitelist.json                  # source of truth — parent edits this
app/                            # hosted web app (GitHub Pages root, at /app/)
  videos_cache.json             # generated — do not hand-edit
scripts/refresh-cache.mjs       # Node 18+, zero dependencies
.github/workflows/refresh-cache.yml
shell/                          # webOS .ipk source
  appinfo.json
  index.html                   # redirect stub -> hosted URL
  icon.png                      # 80x80
```
