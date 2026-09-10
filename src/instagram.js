// src/instagram.js
// Thin client over the Instagram API with Instagram Login (graph.instagram.com).
// Uses "IGA..." access tokens (not Facebook "EAA..." Graph API tokens).
// Publishing is always a 2-step "container" flow:
//   1. Create a media container  -> POST /{ig-user-id}/media
//   2. (videos/reels) poll until FINISHED -> GET /{container-id}?fields=status_code
//   3. Publish the container      -> POST /{ig-user-id}/media_publish
//
// The host is configurable via config.igGraphHost (see config.js) so the same
// client can target graph.facebook.com with an "EAA..." token if ever needed.
//
// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing
// Native fetch (Node 20+) — no dependencies.

import { config } from "./config.js";

function base() {
  return `${config.igGraphHost}/${config.igApiVersion}`;
}

export async function graphPost(path, params) {
  const url = `${base()}${path}`;
  const body = new URLSearchParams({
    ...params,
    access_token: config.igAccessToken,
  });
  const res = await fetch(url, { method: "POST", body });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(
      `IG POST ${path} failed: ${JSON.stringify(data.error || data)}`
    );
  }
  return data;
}

export async function graphGet(path, params = {}) {
  const qs = new URLSearchParams({
    ...params,
    access_token: config.igAccessToken,
  });
  const url = `${base()}${path}?${qs}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(
      `IG GET ${path} failed: ${JSON.stringify(data.error || data)}`
    );
  }
  return data;
}

/** Create a single-image container. Returns the container (creation) id. */
export async function createImageContainer({ imageUrl, caption, altText }) {
  const params = { image_url: imageUrl };
  if (caption) params.caption = caption;
  if (altText) params.alt_text = altText;
  const { id } = await graphPost(`/${config.igUserId}/media`, params);
  return id;
}

/** Create a Reel container. Video must be 9:16, 5–90s, H.264/HEVC, MP4/MOV. */
export async function createReelContainer({
  videoUrl,
  caption,
  coverUrl,
  shareToFeed = true,
}) {
  const params = {
    media_type: "REELS",
    video_url: videoUrl,
    share_to_feed: String(shareToFeed),
  };
  if (caption) params.caption = caption;
  if (coverUrl) params.cover_url = coverUrl;
  const { id } = await graphPost(`/${config.igUserId}/media`, params);
  return id;
}

/** Create a carousel (2–10 items). `items` = [{ imageUrl } | { videoUrl }]. */
export async function createCarouselContainer({ items, caption }) {
  if (!Array.isArray(items) || items.length < 2 || items.length > 10) {
    throw new Error("Carousel requires between 2 and 10 items.");
  }
  const childIds = [];
  for (const item of items) {
    const params = { is_carousel_item: "true" };
    if (item.imageUrl) params.image_url = item.imageUrl;
    else if (item.videoUrl) {
      params.media_type = "VIDEO";
      params.video_url = item.videoUrl;
    } else {
      throw new Error("Each carousel item needs an imageUrl or videoUrl.");
    }
    const { id } = await graphPost(`/${config.igUserId}/media`, params);
    childIds.push(id);
  }
  // Child video containers need processing too — wait for all of them.
  for (const id of childIds) await waitForContainer(id).catch(() => {});
  const parentParams = {
    media_type: "CAROUSEL",
    children: childIds.join(","),
  };
  if (caption) parentParams.caption = caption;
  const { id } = await graphPost(`/${config.igUserId}/media`, parentParams);
  return id;
}

/**
 * Poll a container until it's ready to publish.
 * Images are usually FINISHED immediately; videos/reels take ~30s–2min.
 * Meta recommends polling ~once/minute for up to 5 minutes.
 */
export async function waitForContainer(
  containerId,
  { maxAttempts = 30, intervalMs = 6000 } = {}
) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { status_code } = await graphGet(`/${containerId}`, {
      fields: "status_code",
    });
    if (status_code === "FINISHED") return;
    if (status_code === "ERROR" || status_code === "EXPIRED") {
      throw new Error(`Container ${containerId} status: ${status_code}`);
    }
    // IN_PROGRESS or PUBLISHED-pending — wait and retry
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Container ${containerId} did not finish within ${
      (maxAttempts * intervalMs) / 1000
    }s`
  );
}

/** Publish a finished container. Returns the published media id. */
export async function publishContainer(containerId) {
  const { id } = await graphPost(`/${config.igUserId}/media_publish`, {
    creation_id: containerId,
  });
  return id;
}

/** Add a comment to a published Instagram media object. */
export async function createMediaComment(mediaId, message) {
  return graphPost(`/${mediaId}/comments`, { message });
}

/** How many API posts you've used in the rolling 24h window (limit is 100). */
export async function getPublishingLimit() {
  const data = await graphGet(`/${config.igUserId}/content_publishing_limit`, {
    fields: "config,quota_usage",
  });
  return data;
}
