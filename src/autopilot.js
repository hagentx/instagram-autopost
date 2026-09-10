// src/autopilot.js
// Automatic photo -> Gemini analysis -> rendered post -> scheduled queue.

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join, extname } from "node:path";
import { config, requireGeminiConfig, ROOT } from "./config.js";
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
  timesUtc: (process.env.POST_TIME_UTC || "17:00")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort((a, b) => toMinutes(a) - toMinutes(b)),
};

export function nextSlot(afterMs, cad = cadence) {
  const times = cad.timesUtc?.length ? cad.timesUtc : ["17:00"];
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
      if (cand > afterMs) return new Date(cand);
    }
  }

  throw new Error("No posting slot within 14 days — check POST_DAYS/POST_TIME_UTC.");
}

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
    "Você é o assistente editorial de um perfil brasileiro de colecionismo dedicado à Xuxa.",
    "Você receberá UMA fotografia de uma peça, produto, revista, embalagem ou item relacionado à coleção.",
    "O objetivo é criar uma frase curta para Instagram com tom de fã, colecionador, nostalgia e memória afetiva.",
    "",
    "CONTEXTO DA MARCA:",
    JSON.stringify(brand, null, 2),
    "",
    "REGRAS DA FRASE:",
    "- Escreva SEMPRE em português do Brasil.",
    "- Crie uma única frase original com 4 a 13 palavras.",
    "- Use linguagem natural, nostálgica, simpática e adequada para um perfil de colecionador.",
    "- A frase pode destacar nostalgia, raridade, memória, época, design, embalagem ou o prazer de colecionar.",
    "- Não invente fatos específicos que não possam ser percebidos na imagem ou fornecidos pelo contexto.",
    "- Não descreva simplesmente a fotografia.",
    "- Não use hashtags.",
    "- Não use emojis.",
    "- Não use aspas.",
    "- Não faça comentários depreciativos, ofensivos ou sexualizados.",
    "- Não faça piadas sobre aparência, idade, corpo ou características pessoais.",
    "- Não use palavras como cancelled/cancelado, cringe, fracasso ou equivalentes para provocar.",
    "- Não transforme o texto em crítica negativa.",
    "- Não reutilize frases anteriores.",
    "",
    "POSIÇÃO DO TEXTO:",
    "- A imagem será centralizada/cortada para formato vertical 4:5.",
    "- Analise o enquadramento final 4:5.",
    "- Identifique a região da cabeça/rosto e informe face_band como frações de 0.0 a 1.0.",
    "- Inclua o cabelo ao estimar a região do rosto.",
    "- Escolha top quando houver mais espaço livre acima do rosto e bottom quando houver mais espaço livre abaixo.",
    "- O texto deve ficar na área mais livre e nunca cobrir o rosto ou o item principal.",
    "",
    "SAÍDA:",
    "Retorne SOMENTE JSON válido, sem Markdown e sem explicações.",
    '{ "line": string, "position": "top" | "bottom", "face_band": { "top": number, "bottom": number }, "alt_text": string }',
    "alt_text deve ser uma frase factual em português descrevendo a imagem para acessibilidade.",
  ].join("\n");
}

function extractJson(text) {
  const stripped = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  const candidates = [stripped];

  if (start >= 0 && end > start) {
    candidates.push(stripped.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object") return obj;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function isRetryableGeminiError(err) {
  const message = String(err?.message || err);
  const match = message.match(/"code"\s*:\s*(\d{3})/);
  if (!match) return false;

  const code = Number(match[1]);
  return code === 408 || code === 429 || code >= 500;
}

async function callGeminiWithRetry(url, options) {
  const MAX_ATTEMPTS = 5;
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`  Gemini attempt ${attempt}/${MAX_ATTEMPTS}...`);
      const res = await fetch(url, options);
      const data = await res.json();

      if (!res.ok || data.error) {
        throw new Error(`Gemini API error: ${JSON.stringify(data.error || data)}`);
      }

      return data;
    } catch (err) {
      lastErr = err;
      if (!isRetryableGeminiError(err) || attempt >= MAX_ATTEMPTS) throw err;

      const delay = 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000);
      console.log(`  Gemini temporary error. Retrying in ${(delay / 1000).toFixed(1)}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastErr;
}

export async function analyzePhoto(filePath, filename, brand, usedLines) {
  const b64 = readFileSync(filePath).toString("base64");
  const ext = extname(filename).toLowerCase();
  const mediaType = ext === ".png" ? "image/png" : "image/jpeg";

  const prompt =
    `Frases já usadas recentemente, que você deve evitar repetir:\n${JSON.stringify(usedLines.slice(-120))}\n\n` +
    "Analise a fotografia e produza a frase editorial em português e os dados de posicionamento pedidos. A frase deve valorizar a memória afetiva e o colecionismo de Xuxa.";

  const body = JSON.stringify({
    systemInstruction: {
      parts: [{ text: buildVisionSystem(brand) }],
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
          { text: prompt },
        ],
      },
    ],
    generationConfig: {
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
      thinkingConfig: {
        thinkingLevel: "minimal",
      },
    },
  });

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(config.geminiModel)}:generateContent`;

  const data = await callGeminiWithRetry(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": config.geminiApiKey,
    },
    body,
  });

  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .filter((part) => typeof part.text === "string" && !part.thought)
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (!text) {
    const finish = candidate?.finishReason || "unknown";
    throw new Error(`Gemini returned no usable text (finishReason: ${finish}).`);
  }

  const parsed = extractJson(text);

  if (parsed?.line) return parsed;

  const finish = candidate?.finishReason || "unknown";
  throw new Error(
    `Could not parse a valid line from Gemini response (finishReason: ${finish}): ${text.slice(0, 400)}`
  );
}

async function main() {
  requireGeminiConfig();

  const review =
    process.argv.includes("--review") ||
    process.env.AUTOPILOT_REVIEW === "true";

  if (!existsSync(MEDIA_DIR)) {
    console.log("No media/ folder — nothing to do.");
    return;
  }

  const queue = existsSync(QUEUE_PATH)
    ? JSON.parse(readFileSync(QUEUE_PATH, "utf8"))
    : [];

  const brand = existsSync(BRAND_PATH)
    ? JSON.parse(readFileSync(BRAND_PATH, "utf8"))
    : {};

  const usedLines = existsSync(LINES_PATH)
    ? JSON.parse(readFileSync(LINES_PATH, "utf8"))
    : [];

  const candidates = [];

  for (const f of readdirSync(MEDIA_DIR).filter((f) => !f.startsWith("."))) {
    const full = join(MEDIA_DIR, f);
    if (statSync(full).isDirectory()) continue;

    const ext = extname(f).toLowerCase();
    if (![".jpg", ".jpeg", ".png"].includes(ext)) continue;
    if (isQueued(queue, f)) continue;

    const size = statSync(full).size;
    if (size > 4.5 * 1024 * 1024) {
      console.log(`skip ${f}: ${(size / 1e6).toFixed(1)} MB — resize under ~4 MB`);
      continue;
    }

    candidates.push(f);
  }

  candidates.sort();

  if (candidates.length === 0) {
    console.log("No new photos to schedule.");
    return;
  }

  console.log(`Found ${candidates.length} new photo(s): ${candidates.join(", ")}`);

  let latest = Date.now();
  for (const item of queue) {
    if ((item.status === "scheduled" || item.status === "published") && item.publish_at) {
      latest = Math.max(latest, Date.parse(item.publish_at));
    }
  }

  if (!existsSync(RENDERED_DIR)) mkdirSync(RENDERED_DIR, { recursive: true });

  let added = 0;

  for (const f of candidates) {
    try {
      console.log(`Analyzing ${f} ...`);

      const { line, position = "top", face_band, alt_text } = await analyzePhoto(
        join(MEDIA_DIR, f),
        f,
        brand,
        usedLines
      );

      const outName = `post-${slug(f)}.jpg`;
      const outRel = `media/rendered/${outName}`;

      await overlayCaption(
        join(MEDIA_DIR, f),
        line,
        join(RENDERED_DIR, outName),
        { position, faceBand: face_band }
      );

      const slot = nextSlot(latest);
      latest = slot.getTime();

      queue.push({
        id: `${slot.toISOString().slice(0, 10)}-${slug(f)}`,
        status: review ? "draft" : "scheduled",
        publish_at: slot.toISOString(),
        media_type: "IMAGE",
        media_url: publicUrlFor(outRel),
        alt_text: alt_text || line,
        caption: line,
        source_file: f,
      });

      usedLines.push(line);
      added++;

      console.log(`  "${line}" [${position}] -> ${review ? "draft" : slot.toISOString()}`);
    } catch (err) {
      console.error(`  FAILED on ${f}: ${err.message}`);
    }
  }

  if (added > 0) {
    writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + "\n");
    writeFileSync(LINES_PATH, JSON.stringify(usedLines, null, 2) + "\n");
    console.log(
      review
        ? `${added} draft(s) added — review, then flip status to 'scheduled'.`
        : `${added} post(s) scheduled — the publisher takes it from here.`
    );
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
