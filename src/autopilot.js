// src/autopilot.js
// The "drop a photo, get a post" pipeline.
//
// Scans media/ for NEW photos (skips anything already in the queue), has Gemini
// LOOK at each one and (a) write a one-liner in the brand voice and (b) say
// which band — top or bottom — is clear of the face. It burns the line onto the
// photo in the brand font, reuses the same line as the post caption, and
// schedules it on your cadence. The publisher posts it when the time comes.
//
// Run:  node src/autopilot.js             (caption + schedule new photos)
//       node src/autopilot.js --review    (add as drafts for approval instead)
//
// Cadence (env or GitHub repo Variables):
//   POST_DAYS      default "MON,TUE,WED,THU,FRI,SAT,SUN"  (daily)
//   POST_TIME_UTC  default "17:00" — one OR MORE times, comma-separated, for
//                  multiple posts per day, e.g. "13:00,21:00" posts twice daily.

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";

import { join, extname, basename } from "node:path";

import {
  config,
  requireGeminiConfig,
  ROOT,
} from "./config.js";

import { overlayCaption } from "./overlay.js";

const MEDIA_DIR = join(ROOT, "media");
const RENDERED_DIR = join(ROOT, "media", "rendered");
const QUEUE_PATH = join(ROOT, "content", "queue.json");
const BRAND_PATH = join(ROOT, "brand.json");
const LINES_PATH = join(ROOT, "content", "lines.json");

const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const toMinutes = (t) => {
  const [hh, mm] = t.split(":").map(Number);
  return hh * 60 + mm;
};

export const cadence = {
  days: (process.env.POST_DAYS || "MON,TUE,WED,THU,FRI,SAT,SUN")
    .split(",")
    .map((s) => s.trim().toUpperCase()),

  // One or more posting times per day (comma-separated "HH:MM"), sorted.
  timesUtc: (process.env.POST_TIME_UTC || "17:00")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort((a, b) => toMinutes(a) - toMinutes(b)),
};

export function nextSlot(afterMs, cad = cadence) {
  const times =
    cad.timesUtc && cad.timesUtc.length ? cad.timesUtc : ["17:00"];

  const base = new Date(afterMs);

  for (let i = 0; i <= 14; i++) {
    const y = base.getUTCFullYear();
    const mo = base.getUTCMonth();
    const d = base.getUTCDate() + i;
    const dow = new Date(Date.UTC(y, mo, d)).getUTCDay();

    if (!cad.days.includes(DAY_NAMES[dow])) continue;

    for (const t of times) {
      const [hh, mm] = t.split(":").map(Number);
      const cand = Date.UTC(y, mo, d, hh, mm, 0, 0);

      if (cand > afterMs) {
        return new Date(cand);
      }
    }
  }

  throw new Error(
    `No posting slot within 14 days — check POST_DAYS/POST_TIME_UTC.`
  );
}

/** Already scheduled/posted? Matched by the ORIGINAL source filename. */
export function isQueued(queue, filename) {
  return queue.some((item) => item.source_file === filename);
}

export function publicUrlFor(relPath) {
  if (config.mediaBaseUrl) {
    return `${config.mediaBaseUrl.replace(/\/$/, "")}/${relPath}`;
  }

  const repo = process.env.GITHUB_REPOSITORY;

  if (repo) {
    const branch = process.env.GITHUB_REF_NAME || "main";

    return `https://raw.githubusercontent.com/${repo}/${branch}/${relPath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
  }

  throw new Error(
    "Can't build a public URL: set MEDIA_BASE_URL, or run inside GitHub Actions on a PUBLIC repo."
  );
}

function slug(s) {
  return s
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function buildVisionSystem(brand) {
  return [
    "You are the voice of the brand below. You'll be shown ONE photo. Do two jobs.",
    "",
    "BRAND:",
    JSON.stringify(brand, null, 2),
    "",
    "JOB 1 — WRITE THE LINE:",
    "- Write one original one-liner in the brand voice.",
    "- The line must be 4-13 words.",
    "- Use lowercase.",
    "- No hashtags.",
    "- No emojis.",
    "- No quotation marks.",
    "- Do not simply describe the photograph.",
    "- The photograph may be used for context, but the line should feel like an original social-media caption.",
    "- Avoid generic phrases and predictable jokes.",
    "- Make the line interesting, memorable and suitable for Instagram.",
    "- Do not reuse or closely echo any voice example or previously used line.",
    "",
    "JOB 2 — PLACE THE TEXT:",
    "- The image will be CENTER-CROPPED to a vertical 4:5 frame.",
    "- Reason about the FINAL cropped frame, not the original image.",
    "- Find the head/face in the cropped frame and report face_band as fractions from 0.0 (top edge) to 1.0 (bottom edge).",
    "- Include hair when estimating the face area.",
    "- Be generous rather than clipping the face.",
    '- Set "position" to "top" if there is more empty space above the face, or "bottom" if there is more empty space below.',
    "- Choose the roomier side so the text stays clearly away from the face.",
    "",
    "OUTPUT:",
    "Return ONLY valid JSON. No Markdown fences. No explanation.",
    '{ "line": string, "position": "top" | "bottom", "face_band": { "top": number, "bottom": number }, "alt_text": string }',
    "",
    "alt_text must be one factual sentence describing the photograph for accessibility.",
  ].join("\n");
}

/** Pull a JSON object out of a model response, tolerant of fences/prose. */
function extractJson(text) {
  const stripped = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  for (const candidate of [
    stripped,
    stripped.slice(
      stripped.indexOf("{"),
      stripped.lastIndexOf("}") + 1
    ),
  ]) {
    try {
      const obj = JSON.parse(candidate);

      if (obj && typeof obj === "object") {
        return obj;
      }
    } catch {
      /* try next candidate */
    }
  }

  return null;
}

/**
 * Returns true when an error is likely temporary and worth retrying.
 *
 * Retry:
 *   408 = request timeout
 *   429 = rate limit / temporary quota pressure
 *   500+ = temporary server-side error, including 503 overload
 */
function isRetryableGeminiError(err) {
  const message = String(err?.message || err);

  const match = message.match(
    /"code"\s*:\s*(\d{3})/
  );

  if (!match) {
    return false;
  }

  const code = Number(match[1]);

  return (
    code === 408 ||
    code === 429 ||
    code >= 500
  );
}

/**
 * Gemini API call with exponential backoff.
 *
 * Attempt 1: immediately
 * Attempt 2: ~2 seconds later
 * Attempt 3: ~4 seconds later
 * Attempt 4: ~8 seconds later
 * Attempt 5: ~16 seconds later
 *
 * A small random jitter prevents several simultaneous GitHub Actions
 * executions from retrying at exactly the same instant.
 */
async function callGeminiWithRetry(url, options) {
  const MAX_ATTEMPTS = 5;

  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(
        `  Gemini attempt ${attempt}/${MAX_ATTEMPTS}...`
      );

      const res = await fetch(url, options);

      const data = await res.json();

      if (!res.ok || data.error) {
        throw new Error(
          `Gemini API error: ${JSON.stringify(
            data.error || data
          )}`
        );
      }

      return data;
    } catch (err) {
      lastErr = err;

      const retryable = isRetryableGeminiError(err);

      if (!retryable || attempt >= MAX_ATTEMPTS) {
        throw err;
      }

      const baseDelay = 2000 * Math.pow(2, attempt - 1);

      const jitter = Math.floor(
        Math.random() * 1000
      );

      const delay = baseDelay + jitter;

      console.log(
        `  Gemini temporary error. Retrying in ${(delay / 1000).toFixed(1)}s...`
      );

      await new Promise((resolve) =>
        setTimeout(resolve, delay)
      );
    }
  }

  throw lastErr;
}

export async function analyzePhoto(
  filePath,
  filename,
  brand,
  usedLines
) {
  const b64 = readFileSync(filePath).toString("base64");

  const ext = extname(filename).toLowerCase();

  const mediaType =
    ext === ".png"
      ? "image/png"
      : "image/jpeg";

  const prompt =
    `Recently used lines (avoid echoing):\n${JSON.stringify(
      usedLines.slice(-120)
    )}\n\n` +
    "Write the line and report text placement for this photo.";

  const body = JSON.stringify({
    systemInstruction: {
      parts: [
        {
          text: buildVisionSystem(brand),
        },
      ],
    },

    contents: [
      {
        role: "user",

        parts: [
          {
            inlineData: {
              mimeType: mediaType,
              data: b64,
            },
          },

          {
            text: prompt,
          },
        ],
      },
    ],

    generationConfig: {
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
    },
  });

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(config.geminiModel)}:generateContent`;

  const data = await callGeminiWithRetry(
    url,
    {
      method: "POST",

      headers: {
        "content-type": "application/json",
        "x-goog-api-key": config.geminiApiKey,
      },

      body,
    }
  );

  const text = (data.candidates || [])
    .flatMap(
      (candidate) =>
        candidate.content?.parts || []
    )
    .filter(
      (part) =>
        typeof part.text === "string"
    )
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error(
      `Gemini returned no text: ${JSON.stringify(
        data
      ).slice(0, 500)}`
    );
  }

  const parsed = extractJson(text);

  if (parsed && parsed.line) {
    return parsed;
  }

  throw new Error(
    `Could not parse a valid line from Gemini response: ${text.slice(
      0,
      200
    )}`
  );
}

async function main() {
  requireGeminiConfig();

  const review =
    process.argv.includes("--review") ||
    process.env.AUTOPILOT_REVIEW === "true";

  if (!existsSync(MEDIA_DIR)) {
    console.log(
      "No media/ folder — nothing to do."
    );

    return;
  }

  const queue = existsSync(QUEUE_PATH)
    ? JSON.parse(
        readFileSync(
          QUEUE_PATH,
          "utf8"
        )
      )
    : [];

  const brand = existsSync(BRAND_PATH)
    ? JSON.parse(
        readFileSync(
          BRAND_PATH,
          "utf8"
        )
      )
    : {};

  const usedLines = existsSync(LINES_PATH)
    ? JSON.parse(
        readFileSync(
          LINES_PATH,
          "utf8"
        )
      )
    : [];

  // New, postable source photos.
  // Skip the rendered/output folder and non-images.
  const candidates = [];

  for (
    const f of readdirSync(MEDIA_DIR).filter(
      (f) => !f.startsWith(".")
    )
  ) {
    const full = join(
      MEDIA_DIR,
      f
    );

    if (statSync(full).isDirectory()) {
      continue;
    }

    const ext = extname(f).toLowerCase();

    if (
      ![".jpg", ".jpeg", ".png"].includes(
        ext
      )
    ) {
      if (f !== "README.md") {
        console.log(
          `skip ${f}: not a JPEG/PNG`
        );
      }

      continue;
    }

    if (isQueued(queue, f)) {
      continue;
    }

    const size = statSync(full).size;

    if (size > 4.5 * 1024 * 1024) {
      console.log(
        `skip ${f}: ${(size / 1e6).toFixed(
          1
        )} MB — resize under ~4 MB`
      );

      continue;
    }

    candidates.push(f);
  }

  candidates.sort();

  if (candidates.length === 0) {
    console.log(
      "No new photos to schedule."
    );

    return;
  }

  console.log(
    `Found ${candidates.length} new photo(s): ${candidates.join(
      ", "
    )}`
  );

  // Schedule after the latest thing already on the calendar.
  let latest = Date.now();

  for (const item of queue) {
    if (
      (
        item.status === "scheduled" ||
        item.status === "published"
      ) &&
      item.publish_at
    ) {
      latest = Math.max(
        latest,
        Date.parse(
          item.publish_at
        )
      );
    }
  }

  if (!existsSync(RENDERED_DIR)) {
    mkdirSync(
      RENDERED_DIR,
      { recursive: true }
    );
  }

  let added = 0;

  for (const f of candidates) {
    try {
      console.log(
        `Analyzing ${f} ...`
      );

      const {
        line,
        position = "top",
        face_band,
        alt_text,
      } = await analyzePhoto(
        join(MEDIA_DIR, f),
        f,
        brand,
        usedLines
      );

      // Burn the line onto the photo in the brand font,
      // in the clear band.
      const outName =
        `post-${slug(f)}.jpg`;

      const outRel =
        `media/rendered/${outName}`;

      await overlayCaption(
        join(MEDIA_DIR, f),
        line,
        join(
          RENDERED_DIR,
          outName
        ),
        {
          position,
          faceBand: face_band,
        }
      );

      const slot =
        nextSlot(latest);

      latest =
        slot.getTime();

      queue.push({
        id:
          `${slot
            .toISOString()
            .slice(0, 10)}-${slug(f)}`,

        status:
          review
            ? "draft"
            : "scheduled",

        publish_at:
          slot.toISOString(),

        media_type:
          "IMAGE",

        media_url:
          publicUrlFor(outRel),

        alt_text:
          alt_text || line,

        caption:
          line,

        source_file:
          f,
      });

      usedLines.push(line);

      added++;

      console.log(
        `  "${line}" [${position}] -> ${
          review
            ? "draft"
            : slot.toISOString()
        }`
      );

    } catch (err) {
      console.error(
        `  FAILED on ${f}: ${err.message}`
      );
    }
  }

  if (added > 0) {
    writeFileSync(
      QUEUE_PATH,
      JSON.stringify(
        queue,
        null,
        2
      ) + "\n"
    );

    writeFileSync(
      LINES_PATH,
      JSON.stringify(
        usedLines,
        null,
        2
      ) + "\n"
    );

    console.log(
      review
        ? `${added} draft(s) added — review, then flip status to 'scheduled'.`
        : `${added} post(s) scheduled — the publisher takes it from here.`
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url ===
    `file://${process.argv[1]}`
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
