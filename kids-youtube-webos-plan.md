# Kid-Safe YouTube App for LG webOS TV — Plan

**Goal:** custom TV app that only plays videos from a whitelist of channels you approve. No YouTube algorithm, no suggested content, no search. Personal use only (Developer Mode sideload, not published to LG Content Store).

> Revised 2026-07-16 after doc research. Key changes from v1: hosted-app architecture is **required** (YouTube embeds fail from `file://`), `rel=0` no longer hides related videos (mitigated via player-state handling), Shorts filtering and embeddable pre-checks added to the cache pipeline, quota section updated to the June 2026 model.

---

## 1. Architecture

```
[whitelist.json]  →  [refresh script (cron / GitHub Action, daily)]
                              │  YouTube Data API v3 (playlistItems + videos)
                              ▼
                     [app/videos_cache.json]
                              │
        GitHub Pages (https) hosts app/ + cache
                              │
[webOS .ipk shell]  →  redirects to hosted app URL  →  plays via IFrame Player API
```

- **Hosted web app, not packaged.** YouTube embeds show "Video Unavailable" when the parent page is loaded via `file://` (how packaged webOS apps load). The `.ipk` is a thin stub whose `index.html` redirects to the hosted URL. Bonus: UI + whitelist updates never require re-sideloading.
- TV makes **zero** YouTube API calls — it only reads the pre-built `videos_cache.json`.
- No login required — anonymous IFrame playback. API key lives only in the refresh job (GitHub Actions secret).

---

## 2. Tech stack

- **App:** plain HTML/CSS/JS (fully supported; Enact not needed)
- **Player:** YouTube IFrame Player API (`https://www.youtube.com/iframe_api`)
- **Data source:** YouTube Data API v3 (`channels.list`, `playlistItems.list`, `videos.list` — no `search.list`)
- **Hosting:** GitHub Pages (repo doubles as whitelist + cache storage; GitHub Action runs the daily refresh)
- **Tooling:** webOS TV CLI — `npm install -g @webos-tools/cli` (the old standalone SDK installer is deprecated); optional webOS Studio VS Code extension; Simulator (webOS 22+ only) for rough UI checks
- **Packaging:** `.ipk` via `ares-package`

---

## 3. Repo layout

```
webos-yt-kids/
├── whitelist.json               # source of truth — parent edits this
├── app/                         # hosted web app (GitHub Pages root)
│   ├── index.html
│   ├── videos_cache.json        # generated — do not hand-edit
│   ├── css/style.css            # 10-foot UI
│   └── js/
│       ├── main.js              # boot, load cache, render channel rows
│       ├── player.js            # IFrame API wrapper + safety behaviors
│       └── remote.js            # D-pad/OK/Back (keyCode 461) navigation
├── shell/                       # webOS .ipk source
│   ├── appinfo.json
│   ├── index.html               # redirect stub → hosted URL
│   └── icon.png                 # 80×80, required
├── scripts/refresh-cache.mjs    # Node 18+, no deps
└── .github/workflows/refresh-cache.yml   # daily cron
```

---

## 4. Data model

`whitelist.json`:

```json
{
  "channels": [
    { "channelId": "UCxxxx", "name": "Kids Song Channel", "maxVideos": 30 }
  ],
  "individualVideos": [
    { "videoId": "abc123", "title": "Specific approved video" }
  ]
}
```

`videos_cache.json` (generated):

```json
{
  "generatedAt": "2026-07-16T00:00:00Z",
  "channels": [
    {
      "channelId": "UCxxxx",
      "name": "Kids Song Channel",
      "videos": [
        {
          "videoId": "...",
          "title": "...",
          "publishedAt": "...",
          "durationSeconds": 245,
          "thumbnail": "https://img.youtube.com/vi/<id>/hqdefault.jpg"
        }
      ]
    }
  ],
  "picks": [ { "videoId": "abc123", "title": "..." } ]
}
```

Thumbnails come from `img.youtube.com/vi/<id>/hqdefault.jpg` — free, no API call (unofficial but longstanding).

---

## 5. Refresh pipeline & API quota

Costs (June 2026 quota model — shared pool still 10,000 units/day; `search.list` moved to its own small bucket, which we don't use at all):

1. `channels.list?part=contentDetails` — all whitelisted channels in one batched call (1 unit) → `relatedPlaylists.uploads` IDs
2. `playlistItems.list` per channel — newest 50 uploads, 1 unit each
3. `videos.list?part=contentDetails,status,snippet` — batched 50 IDs/call (1 unit) to get durations + embeddable flag
4. Filter: drop **Shorts** (duration ≤ 62s heuristic — no official API flag exists; `individualVideos` are exempt from the filter) and drop **non-embeddable** videos (`status.embeddable == false`) so error-101/150 videos never reach the grid
5. Write `app/videos_cache.json`; GitHub Action commits if changed

Daily cost for ~10 channels: ≈ 15 units vs 10,000 quota. Also keeps the Google Cloud project active (Google may curtail projects idle > 90 days).

---

## 6. Player behavior — kid-safety mitigations

**Reality check: `rel=0` does NOT hide related videos** (since Sept 2018 it only restricts them to the same channel). Suggestions still appear on **pause and end screens**. Mitigations, in the app:

- **On `ENDED`:** immediately auto-advance to the next whitelisted video in the row (or return to our grid). The end screen never gets a chance to render.
- **On `PAUSED`:** hide the iframe and show our own pause screen (resume/back buttons). *Hide, don't overlay* — YouTube's developer policies explicitly ban overlaying a visible player; hiding/replacing the iframe is the tolerated pattern (still a ToS gray zone; acceptable risk for a private family app).
- **On `onError` 101/150** (embedding disabled) or 100 (removed/private): skip to next video. The cache pre-filter should make this rare.
- Player params: `rel=0`, `iv_load_policy=3`, `playsinline=1`, `controls=1` (keep controls — the Magic Remote pointer is needed to click "Skip Ad").
- **Autoplay:** first play always comes from a grid selection (a user gesture), so it's allowed. For auto-advance, handle `onAutoplayBlocked` (fallback: start muted, unmute on gesture).
- **Ads:** cannot be blocked or auto-skipped (ToS, no API hook). Child clicks **Skip Ad** with the Magic Remote pointer — pointer acts as an OS-level mouse so clicks inside the iframe should work (unverified on webOS specifically; validate in the step-0 test).
- **Made-for-kids videos:** embeddable, and YouTube auto-disables cards/end-screens/comments on them (helps us). ToS technically requires clients to check `madeForKids` status per embedded video; noted, low practical risk for private use.
- No search bar, no comments, no channel-jump — surface area stays minimal.

---

## 7. App structure / TV input

- Grid UI: horizontal channel rows (Netflix-style), large focus states, 10-foot design.
- **Remote input:** `keydown` — arrows 37/38/39/40, OK 13, **Back = 461**. Set `disableBackHistoryAPI: true` in `appinfo.json` so Back reaches the app as keyCode 461.
- Magic Remote pointer fires normal mouse events (hover/click) — support both pointer and 5-way nav.
- `appinfo.json` required fields: `id`, `title`, `type: "web"`, `main`, `icon` (80×80 PNG), `version`.

---

## 8. Dev Mode setup (one-time)

1. On TV: LG Content Store → install **Developer Mode** app
2. Create free LG Developer account (developer.lge.com)
3. Sign into Developer Mode app → toggle **Dev Mode Status** on → TV reboots
4. On PC: `npm install -g @webos-tools/cli`
5. Pair PC↔TV: `ares-setup-device` with passphrase from the Developer Mode app (Key Server on)
6. Confirm: `ares-device-info --device <tvname>`

---

## 9. Build & deploy loop

```bash
ares-package ./shell                          # → produces .ipk
ares-install --device <tvname> com.family.kidsyoutube_1.0.0_all.ipk
ares-launch  --device <tvname> com.family.kidsyoutube
```

App logic iterates on the **hosted** side — push to GitHub Pages, relaunch app on TV. The `.ipk` only changes if the hosted URL or app metadata changes. Simulator (webOS 22+) is fine for layout checks but has no DRM and unverified YouTube-embed fidelity — trust only the real TV for playback behavior.

**Step 0 (do first, before building the full UI):** sideload a minimal hosted-app stub that embeds one video via the IFrame API on the actual TV. This validates the two riskiest unknowns at once — hosted embed playback and Magic Remote clicks inside the iframe (Skip Ad).

---

## 10. Maintenance

- **Dev Mode session:** ~1000 hrs (~41 days), extendable indefinitely — open Developer Mode app → **Extend** before it lapses. On expiry all sideloaded apps are uninstalled; reinstall via `ares-install`, no data loss (whitelist + cache live in the repo).
- Dev Mode also self-disables after **10 TV reboots with no network connection**.
- **TV firmware updates uninstall sideloaded apps** and may require re-pairing — reinstall is a 2-command job.
- **Whitelist updates:** edit `whitelist.json`, push; next cron run (or manual workflow dispatch) refreshes the cache. No TV-side action needed.

---

## 11. Out of scope / explicitly rejected

- Ad blocking or auto-skip (ToS risk, no technical hook)
- Publishing to LG Content Store (unnecessary certification overhead for single-family use)
- Using personal YouTube Premium session in-app (doesn't carry over to IFrame embeds; cookie hacks are fragile + ToS-risky)
- Homebrew/jailbreak (RootMyTV) to remove the Dev Mode limit — firmware-update risk, not worth it
- Overlaying the player to mask pause/end screens (explicitly prohibited — we hide/replace the iframe instead)

---

## Next steps

1. ~~Research feasibility~~ ✅ (2026-07-16)
2. Build: app frontend, refresh pipeline, webOS shell, workflow
3. Get YouTube Data API key (Google Cloud Console) + create GitHub repo, enable Pages, set `YT_API_KEY` secret
4. Pick channels for `whitelist.json`
5. **Step-0 TV test** (hosted embed + Skip-Ad click), then full app test on TV
