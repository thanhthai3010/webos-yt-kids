#!/usr/bin/env node
// Refresh app/videos_cache.json from whitelist.json using the YouTube Data API v3.
// Node 18+, zero dependencies (uses global fetch).
//
// Usage:
//   YT_API_KEY=xxxxx node scripts/refresh-cache.mjs
//
// Exit codes:
//   0 - success (cache written), even if some channels were skipped with warnings
//   1 - total failure (no cache written): missing API key, whitelist unreadable,
//       or every channel/video failed

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const WHITELIST_PATH = path.join(REPO_ROOT, "whitelist.json");
const CACHE_PATH = path.join(REPO_ROOT, "app", "videos_cache.json");

const API_BASE = "https://www.googleapis.com/youtube/v3";
const SHORTS_MAX_SECONDS = 62;

let quotaUnits = 0;

function log(...args) {
  console.error(...args);
}

async function main() {
  const apiKey = process.env.YT_API_KEY;
  if (!apiKey) {
    log(
      "ERROR: YT_API_KEY environment variable is not set. " +
        "Get a YouTube Data API v3 key from https://console.cloud.google.com/ " +
        "and run: YT_API_KEY=xxxxx node scripts/refresh-cache.mjs"
    );
    process.exit(1);
  }

  let whitelist;
  try {
    const raw = await readFile(WHITELIST_PATH, "utf8");
    whitelist = JSON.parse(raw);
  } catch (err) {
    log(`ERROR: could not read/parse whitelist.json at ${WHITELIST_PATH}: ${err.message}`);
    process.exit(1);
  }

  const channels = Array.isArray(whitelist.channels) ? whitelist.channels : [];
  const individualVideos = Array.isArray(whitelist.individualVideos)
    ? whitelist.individualVideos
    : [];

  if (channels.length === 0 && individualVideos.length === 0) {
    log("ERROR: whitelist.json has no channels and no individualVideos. Nothing to do.");
    process.exit(1);
  }

  // --- Step 1: channels.list to resolve uploads playlist IDs ---
  // Entries may use "channelId" (UC…) or "handle" (@name, bare name, or a
  // youtube.com/@name URL). Handles cost one channels.list call each
  // (forHandle can't be batched); IDs are batched 50 per call.
  const uploadsPlaylistByChannel = new Map();

  for (const c of channels) {
    // Forgiving input: a handle or channel URL pasted into "channelId" works too.
    const handle = c.handle ? extractHandle(c.handle, true) : extractHandle(c.channelId, false);
    if (!handle) continue;

    try {
      const url = new URL(`${API_BASE}/channels`);
      url.searchParams.set("part", "contentDetails,snippet");
      url.searchParams.set("forHandle", handle);
      url.searchParams.set("key", apiKey);

      const data = await fetchJson(url);
      quotaUnits += 1;

      const item = (data.items ?? [])[0];
      if (!item) {
        log(`WARN: handle "@${handle}" not found — channel "${c.name ?? handle}" will be skipped.`);
        continue;
      }
      c.channelId = item.id;
      if (!c.name) c.name = item.snippet?.title ?? handle;
      const uploads = item.contentDetails?.relatedPlaylists?.uploads;
      if (uploads) uploadsPlaylistByChannel.set(item.id, uploads);
    } catch (err) {
      log(`WARN: could not resolve handle "@${handle}": ${err.message}`);
    }
  }

  const channelIds = channels
    .map((c) => c.channelId)
    .filter((id) => id && /^UC[\w-]{22}$/.test(id) && !uploadsPlaylistByChannel.has(id));

  if (channelIds.length > 0) {
    try {
      const batches = chunk(channelIds, 50);
      for (const batch of batches) {
        const url = new URL(`${API_BASE}/channels`);
        url.searchParams.set("part", "contentDetails");
        url.searchParams.set("id", batch.join(","));
        url.searchParams.set("key", apiKey);

        const data = await fetchJson(url);
        quotaUnits += 1;

        for (const item of data.items ?? []) {
          const uploads = item?.contentDetails?.relatedPlaylists?.uploads;
          if (uploads) uploadsPlaylistByChannel.set(item.id, uploads);
        }
      }
    } catch (err) {
      log(`ERROR: channels.list request failed: ${err.message}`);
    }
  }

  // --- Step 2: playlistItems.list per channel (1 page, 50 items) ---
  // Prefer the "UULF" long-form playlist (uploads excluding Shorts — an
  // undocumented but stable YouTube convention); fall back to the raw "UU"
  // uploads playlist if it doesn't exist or is empty. The duration filter in
  // step 4 alone is not enough: Shorts can be up to 3 minutes long.
  const channelVideoIds = new Map(); // channelId -> [videoId]

  for (const channelDef of channels) {
    const { channelId, name } = channelDef;
    const uploadsId = uploadsPlaylistByChannel.get(channelId);

    if (!uploadsId) {
      log(`WARN: channel "${name}" (${channelId}) skipped — could not resolve uploads playlist (check the channelId).`);
      continue;
    }

    const longFormId = "UULF" + uploadsId.slice(2);
    let ids = null;

    for (const playlistId of [longFormId, uploadsId]) {
      try {
        const url = new URL(`${API_BASE}/playlistItems`);
        url.searchParams.set("part", "contentDetails");
        url.searchParams.set("playlistId", playlistId);
        url.searchParams.set("maxResults", "50");
        url.searchParams.set("key", apiKey);

        const data = await fetchJson(url);
        quotaUnits += 1;

        const found = (data.items ?? [])
          .map((item) => item?.contentDetails?.videoId)
          .filter(Boolean);
        if (found.length > 0) {
          if (playlistId === uploadsId && longFormId !== uploadsId) {
            log(`INFO: channel "${name}" (${channelId}) has no long-form playlist; using raw uploads (Shorts filtered by duration only).`);
          }
          ids = found;
          break;
        }
      } catch {
        // Long-form playlist may 404 for channels without one — try the next.
      }
    }

    if (ids) {
      channelVideoIds.set(channelId, ids);
    } else {
      log(`WARN: channel "${name}" (${channelId}) skipped — no videos found via playlists ${longFormId}/${uploadsId}.`);
    }
  }

  // --- Step 3: collect all video IDs (channels + individualVideos), batch videos.list ---
  const allVideoIds = new Set();
  for (const ids of channelVideoIds.values()) {
    for (const id of ids) allVideoIds.add(id);
  }
  for (const v of individualVideos) {
    if (v.videoId) allVideoIds.add(v.videoId);
  }

  const videoDetails = new Map(); // videoId -> details

  if (allVideoIds.size > 0) {
    const batches = chunk([...allVideoIds], 50);
    for (const batch of batches) {
      try {
        const url = new URL(`${API_BASE}/videos`);
        url.searchParams.set("part", "contentDetails,status,snippet");
        url.searchParams.set("id", batch.join(","));
        url.searchParams.set("key", apiKey);

        const data = await fetchJson(url);
        quotaUnits += 1;

        for (const item of data.items ?? []) {
          videoDetails.set(item.id, item);
        }
      } catch (err) {
        log(`WARN: videos.list batch failed (${batch.length} ids): ${err.message}`);
      }
    }
  }

  // --- Step 4: filter + build channels output ---
  const outputChannels = [];

  for (const channelDef of channels) {
    const { channelId, name, maxVideos = 30 } = channelDef;
    const ids = channelVideoIds.get(channelId);
    if (!ids) continue; // already warned above

    let kept = 0;
    const dropped = { notEmbeddable: 0, notPublic: 0, isShort: 0, liveOrUpcoming: 0, missing: 0 };
    const videos = [];

    for (const videoId of ids) {
      const detail = videoDetails.get(videoId);
      if (!detail) {
        dropped.missing += 1;
        continue;
      }
      if (detail.status?.embeddable === false) {
        dropped.notEmbeddable += 1;
        continue;
      }
      if (detail.status?.privacyStatus !== "public") {
        dropped.notPublic += 1;
        continue;
      }
      const durationSeconds = parseIso8601Duration(detail.contentDetails?.duration);
      // Live streams and upcoming premieres have no usable duration (P0D).
      if (
        !durationSeconds ||
        (detail.snippet?.liveBroadcastContent && detail.snippet.liveBroadcastContent !== "none")
      ) {
        dropped.liveOrUpcoming += 1;
        continue;
      }
      if (durationSeconds <= SHORTS_MAX_SECONDS) {
        dropped.isShort += 1;
        continue;
      }

      videos.push({
        videoId,
        title: detail.snippet?.title ?? "(untitled)",
        publishedAt: detail.snippet?.publishedAt ?? null,
        durationSeconds: durationSeconds ?? 0,
        thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      });
    }

    // Sort newest first, cap at maxVideos.
    videos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    const finalVideos = videos.slice(0, maxVideos);
    kept = finalVideos.length;

    log(
      `Channel "${name}" (${channelId}): kept ${kept}/${ids.length} ` +
        `(dropped: notEmbeddable=${dropped.notEmbeddable}, notPublic=${dropped.notPublic}, ` +
        `isShort=${dropped.isShort}, liveOrUpcoming=${dropped.liveOrUpcoming}, missing=${dropped.missing}, ` +
        `truncatedByMaxVideos=${Math.max(0, videos.length - maxVideos)})`
    );

    outputChannels.push({
      channelId,
      name,
      videos: finalVideos,
    });
  }

  // --- Step 5: build picks (individualVideos), exempt from Shorts filter ---
  const picks = [];
  for (const v of individualVideos) {
    const detail = videoDetails.get(v.videoId);
    if (!detail) {
      log(`WARN: individualVideo "${v.title ?? v.videoId}" (${v.videoId}) skipped — no details returned.`);
      continue;
    }
    if (detail.status?.embeddable === false) {
      log(`WARN: individualVideo "${v.title ?? v.videoId}" (${v.videoId}) skipped — not embeddable.`);
      continue;
    }
    picks.push({
      videoId: v.videoId,
      title: v.title ?? detail.snippet?.title ?? "(untitled)",
      thumbnail: `https://img.youtube.com/vi/${v.videoId}/hqdefault.jpg`,
    });
  }

  if (outputChannels.length === 0 && picks.length === 0) {
    log("ERROR: total failure — no channels or picks produced any usable videos. Cache not written.");
    process.exit(1);
  }

  const cache = {
    generatedAt: new Date().toISOString(),
    channels: outputChannels,
    picks,
  };

  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n", "utf8");
  log(`Wrote ${CACHE_PATH}`);
  log(`Estimated quota units used: ${quotaUnits}`);
}

// Pulls a handle out of "@name", "youtube.com/@name" URLs, or (when allowBare)
// a bare "name". Returns null for anything that is already a UC… channel ID.
function extractHandle(value, allowBare) {
  if (!value || typeof value !== "string") return null;
  const v = value.trim();
  const urlMatch = /youtube\.com\/@([\w.\-]+)/i.exec(v);
  if (urlMatch) return urlMatch[1];
  if (v.startsWith("@")) return v.slice(1);
  if (/^UC[\w-]{22}$/.test(v)) return null;
  return allowBare ? v : null;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url.pathname}${body ? ` — ${body.slice(0, 300)}` : ""}`);
  }
  return res.json();
}

// Parses ISO-8601 durations like "PT1H2M3S" into total seconds.
function parseIso8601Duration(duration) {
  if (!duration) return null;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration);
  if (!match) return null;
  const hours = parseInt(match[1] ?? "0", 10);
  const minutes = parseInt(match[2] ?? "0", 10);
  const seconds = parseInt(match[3] ?? "0", 10);
  return hours * 3600 + minutes * 60 + seconds;
}

main().catch((err) => {
  log(`ERROR: unexpected failure: ${err.stack ?? err.message}`);
  process.exit(1);
});
