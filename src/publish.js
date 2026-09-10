// src/publish.js
// Reads content/queue.json, finds posts whose time has come, publishes them
// via the Instagram Graph API, and writes updated statuses back to the queue.
//
// Run:  node src/publish.js            (publishes anything due)
//       node src/publish.js --dry-run  (logs what WOULD post, posts nothing)

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, requireIgConfig, ROOT } from "./config.js";
import {
  createImageContainer,
  createReelContainer,
  createCarouselContainer,
  waitForContainer,
  publishContainer,
  createMediaComment,
  getPublishingLimit,
} from "./instagram.js";

const QUEUE_PATH = join(ROOT, "content", "queue.json");
const DRY_RUN = process.argv.includes("--dry-run");
const DEFAULT_MENTION = "@xuxameneghel";
const DEFAULT_COMMENT = `Com carinho para a eterna Rainha dos Baixinhos: ${DEFAULT_MENTION}`;

/** Turn "media/hat.jpg" into a full URL using MEDIA_BASE_URL; pass URLs through. */
function resolveMedia(urlOrPath) {
  if (!urlOrPath) return urlOrPath;
  if (/^https?:\/\//i.test(urlOrPath)) return urlOrPath;
  if (!config.mediaBaseUrl) {
    throw new Error(
      `"${urlOrPath}" is a relative path but MEDIA_BASE_URL is not set. ` +
        `Use a full public URL, or set MEDIA_BASE_URL.`
    );
  }
  return `${config.mediaBaseUrl.replace(/\/$/, "")}/${urlOrPath.replace(/^\//, "")}`;
}

function loadQueue() {
  return JSON.parse(readFileSync(QUEUE_PATH, "utf8"));
}

function saveQueue(queue) {
  writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + "\n");
}

function isDue(item, now) {
  return (
    item.status === "scheduled" &&
    item.publish_at &&
    Date.parse(item.publish_at) <= now
  );
}

async function publishItem(item) {
  const type = (item.media_type || "IMAGE").toUpperCase();
  let containerId;

  if (type === "IMAGE") {
    containerId = await createImageContainer({
      imageUrl: resolveMedia(item.media_url),
      caption: item.caption,
      altText: item.alt_text,
    });
  } else if (type === "REELS" || type === "VIDEO") {
    containerId = await createReelContainer({
      videoUrl: resolveMedia(item.media_url),
      caption: item.caption,
      coverUrl: item.cover_url ? resolveMedia(item.cover_url) : undefined,
      shareToFeed: item.share_to_feed !== false,
    });
  } else if (type === "CAROUSEL") {
    const items = (item.items || []).map((child) =>
      child.video_url
        ? { videoUrl: resolveMedia(child.video_url) }
        : { imageUrl: resolveMedia(child.image_url) }
    );
    containerId = await createCarouselContainer({ items, caption: item.caption });
  } else {
    throw new Error(`Unknown media_type: ${item.media_type}`);
  }

  await waitForContainer(containerId);
  const mediaId = await publishContainer(containerId);
  return mediaId;
}

async function main() {
  requireIgConfig();
  const now = Date.now();
  const queue = loadQueue();
  const due = queue.filter((item) => isDue(item, now));

  if (due.length === 0) {
    console.log("Nothing due to publish right now.");
    return;
  }

  // Log current publishing quota (limit is 100 posts / rolling 24h).
  try {
    const limit = await getPublishingLimit();
    console.log("Publishing quota:", JSON.stringify(limit.data?.[0] ?? limit));
  } catch (e) {
    console.warn("Could not read publishing limit:", e.message);
  }

  console.log(`Found ${due.length} post(s) due.`);
  let changed = false;

  for (const item of due) {
    const label = item.id || item.publish_at;
    if (DRY_RUN) {
      console.log(`[dry-run] would publish "${label}" (${item.media_type})`);
      continue;
    }
    try {
      console.log(`Publishing "${label}"...`);
      const mediaId = await publishItem(item);
      item.status = "published";
      item.published_at = new Date().toISOString();
      item.media_id = mediaId;

      // The mention is deliberately best-effort: if the Instagram app/token
      // lacks comment-management permission, the post itself remains published.
      try {
        const comment = item.comment || DEFAULT_COMMENT;
        await createMediaComment(mediaId, comment);
        item.comment = comment;
        item.comment_status = "published";
        console.log(`  OK comment added: ${comment}`);
      } catch (commentErr) {
        item.comment_status = "error";
        item.comment_error = String(commentErr.message || commentErr);
        console.warn(`  WARNING: post published, but mention comment failed: ${item.comment_error}`);
      }

      changed = true;
      console.log(`  OK published as media ${mediaId}`);
    } catch (err) {
      item.status = "error";
      item.error = String(err.message || err);
      changed = true;
      console.error(`  FAILED: ${item.error}`);
    }
  }

  if (changed && !DRY_RUN) {
    saveQueue(queue);
    console.log("Queue updated.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
