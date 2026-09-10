// src/autopilot.js
// Automatic photo -> Gemini analysis -> clean rendered copy -> scheduled queue.

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
  copyFileSync,
} from "node:fs";
import { join, extname } from "node:path";
import { config, requireGeminiConfig, ROOT } from "./config.js";

const MEDIA_DIR = join(ROOT, "media");
const RENDERED_DIR = join(ROOT, "media", "rendered");
const QUEUE_PATH = join(ROOT, "content", "queue.json");
const BRAND_PATH = join(ROOT, "brand.json");
const LINES_PATH = join(ROOT, "content", "lines.json");

// As cinco hashtags fixas do perfil. Nenhuma hashtag extra é gerada pelo Gemini.
const DEFAULT_HASHTAGS = [
  "#colexão",
  "#xuxinha",
  "#rainhadosbaixinhos",
  "#colecionismo",
  "#xuxa",
];

// Vocabulário editorial permanente. São palavras/conceitos, não hashtags.
const DEFAULT_KEYWORDS = [
  "Xuxa Meneghel",
  "coleção X",
  "Xou da Xuxa",
  "Planeta Xuxa",
  "Que Xou da Xuxa é esse",
  "Filmes da Xuxa",
  "Sessão X",
  "pôster da Xuxa",
  "boneca da Xuxa",
  "Xuxinha",
  "mimo",
  "brinquedos Mimo",
  "boneca Xuxa da Estrela",
  "brinquedos Estrela",
  "Grow Brasil",
  "CDs da Xuxa",
];

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
    "Você receberá uma fotografia de uma peça, produto, revista, embalagem ou item relacionado à coleção.",
    "A fotografia NÃO deve receber nenhum texto, desenho ou sobreposição. Ela será publicada limpa, preservando o produto original.",
    "",
    "OBJETIVO:",
    "Criar uma legenda de Instagram mais rica, informativa e agradável para colecionadores, combinando uma abertura afetiva com dados do produto que possam ser comprovados pela própria fotografia.",
    "",
    "CONTEXTO DA MARCA:",
    JSON.stringify(brand, null, 2),
    "",
    "VOCABULÁRIO DO PERFIL:",
    DEFAULT_KEYWORDS.join(", "),
    "Use esses termos somente quando forem pertinentes. Nunca transforme a legenda em uma lista artificial de palavras-chave.",
    "",
    "REGRA ABSOLUTA CONTRA INVENÇÃO:",
    "- Use como fatos somente informações legíveis na fotografia ou inequivocamente visíveis nela.",
    "- NÃO invente ano, fabricante, país, distribuição, preço, raridade, tiragem, quantidade produzida, licenciamento ou história do produto.",
    "- NÃO transforme uma hipótese em fato.",
    "- Se uma informação estiver ilegível, ambígua ou não puder ser confirmada pela fotografia, deixe o campo vazio/null.",
    "- Não use conhecimento de memória do modelo para preencher lacunas.",
    "- A pesquisa externa será adicionada posteriormente; nesta etapa, não atribua ao produto informações que não estejam comprovadas na imagem.",
    "",
    "INFORMAÇÕES A EXTRAIR DA IMAGEM:",
    "- Nome/título do produto, se identificável.",
    "- Marca e fabricante, se legíveis.",
    "- Ano ou período, somente se estiver indicado ou claramente impresso.",
    "- Código, referência ou número do produto, se legível.",
    "- País/mercado, somente se indicado na peça/embalagem.",
    "- Linha, coleção ou versão, se indicada.",
    "- Conteúdo/acessórios visíveis e outras características relevantes.",
    "- Uma ou duas curiosidades baseadas exclusivamente em elementos visíveis.",
    "",
    "ESTRUTURA DA LEGENDA:",
    "- product_name: nome principal do produto. Seja específico, mas não invente.",
    "- intro: 1 ou 2 frases curtas, bonitas e naturais, com tom de fã e colecionador.",
    "- details: lista de informações factuais que estejam realmente confirmadas na imagem. Use no máximo 7 itens.",
    "- curiosity: uma curiosidade curta baseada naquilo que aparece na peça/embalagem. Se não houver uma boa curiosidade, use string vazia.",
    "- closing: uma frase curta sobre memória afetiva/colecionismo, sem inventar contexto histórico.",
    "- alt_text: descrição factual da imagem para acessibilidade.",
    "",
    "REGRAS DE TEXTO:",
    "- Português do Brasil.",
    "- Não coloque hashtags dentro de nenhum campo; o sistema acrescentará exatamente cinco hashtags no final.",
    "- Não use emojis em excesso; no máximo dois em toda a legenda.",
    "- Não faça afirmações históricas que não estejam confirmadas na imagem.",
    "- Não copie longos textos da embalagem; resuma quando necessário.",
    "- Não faça comentários depreciativos, ofensivos ou sexualizados.",
    "",
    "SAÍDA:",
    "Retorne SOMENTE JSON válido, sem Markdown e sem explicações.",
    '{ "product_name": string, "intro": string, "details": [{ "label": string, "value": string }], "curiosity": string, "closing": string, "alt_text": string }',
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

  if (start >= 0 && end > start) candidates.push(stripped.slice(start, end + 1));

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

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildCaption(info) {
  const productName = clean(info.product_name) || "Peça da coleção Xuxa";
  const intro = clean(info.intro);
  const details = Array.isArray(info.details)
    ? info.details
        .filter((item) => item && clean(item.label) && clean(item.value))
        .slice(0, 7)
        .map((item) => `📌 ${clean(item.label)}: ${clean(item.value)}`)
    : [];
  const curiosity = clean(info.curiosity);
  const closing = clean(info.closing);

  const parts = [`${productName}`];
  if (intro) parts.push(intro);
  if (details.length) parts.push(details.join("\n"));
  if (curiosity) parts.push(`⭐ Curiosidade: ${curiosity}`);
  if (closing) parts.push(closing);
  parts.push(DEFAULT_HASHTAGS.join(" "));

  return parts.join("\n\n");
}

export async function analyzePhoto(filePath, filename, brand, usedLines) {
  const b64 = readFileSync(filePath).toString("base64");
  const ext = extname(filename).toLowerCase();
  const mediaType = ext === ".png" ? "image/png" : "image/jpeg";

  const prompt =
    `Legendas anteriores, para evitar repetir ideias: ${JSON.stringify(usedLines.slice(-80))}\n\n` +
    "Analise cuidadosamente a fotografia. Extraia apenas fatos que estejam visíveis e legíveis. Depois redija a estrutura solicitada. Se não houver evidência suficiente para um dado, deixe-o vazio. NÃO invente informações para tornar a legenda mais completa.";

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
      maxOutputTokens: 3072,
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
  if (parsed?.product_name || parsed?.intro || Array.isArray(parsed?.details)) return parsed;

  const finish = candidate?.finishReason || "unknown";
  throw new Error(
    `Could not parse a valid product analysis from Gemini (finishReason: ${finish}): ${text.slice(0, 500)}`
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

      const info = await analyzePhoto(join(MEDIA_DIR, f), f, brand, usedLines);
      const caption = buildCaption(info);
      const outExt = extname(f).toLowerCase() === ".png" ? ".png" : ".jpg";
      const outName = `post-${slug(f)}${outExt}`;
      const outRel = `media/rendered/${outName}`;

      // IMPORTANT: the published image is an untouched copy of the original.
      // Gemini text is never rendered over the product photo.
      copyFileSync(join(MEDIA_DIR, f), join(RENDERED_DIR, outName));

      const slot = nextSlot(latest);
      latest = slot.getTime();

      const shortLine = clean(info.intro) || clean(info.product_name) || "Peça da coleção Xuxa";

      queue.push({
        id: `${slot.toISOString().slice(0, 10)}-${slug(f)}`,
        status: review ? "draft" : "scheduled",
        publish_at: slot.toISOString(),
        media_type: "IMAGE",
        media_url: publicUrlFor(outRel),
        alt_text: clean(info.alt_text) || clean(info.product_name) || "Item da coleção Xuxa.",
        caption,
        source_file: f,
        product_name: clean(info.product_name),
        observed_details: Array.isArray(info.details) ? info.details : [],
        research_status: "not_web_verified",
      });

      usedLines.push(shortLine);
      added++;

      console.log(`  Product: ${info.product_name || "(not identified)"}`);
      console.log(`  Clean image copied: ${outRel}`);
      console.log(`  Hashtags: ${DEFAULT_HASHTAGS.join(" ")}`);
      console.log(`  -> ${review ? "draft" : slot.toISOString()}`);
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
