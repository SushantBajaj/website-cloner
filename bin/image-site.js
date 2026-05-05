#!/usr/bin/env node
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-flash-latest";
const FALLBACK_MODELS = ["gemini-2.5-flash","gemini-2.5-flash-lite","gemini-2.0-flash", "gemini-2.0-flash-lite"];
const execFileAsync = promisify(execFile);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".svg", ".ico"]);
const VISION_PREVIEW_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"]);
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};
const MAX_OUTPUT_TOKENS = 30000;
const DEFAULT_MAX_SCREENSHOT_REFERENCES = 8;
const MAX_ASSET_PREVIEWS = 0;
const DEFAULT_SOURCE_BRIEF_CHARS = 50000;
const DEFAULT_REFERENCE_IMAGE_MAX_WIDTH = 960;
const DEFAULT_REFERENCE_IMAGE_QUALITY = 60;

const cwd = process.cwd();
const envKeysSkippedFromFile = new Set();

function usage() {
  return `Usage:
  image-site [asset-folder] [options]

Options:
  --screenshots <folder>  Screenshot reference folder (default: ./screenshot when present)
  --assets <folder>       Extracted website asset folder (default: ./extracted when present)
  --source <file>      Saved page source HTML (default: first .html file in asset folder)
  --source-brief-chars <n> Maximum characters from cleaned source brief to send (default: 18000)
  --screenshot-refs <n> Maximum screenshot reference images/slices to send (default: 4)
  --asset-previews <n> Send this many extracted image previews to the model (default: 0)
  --allow-fallbacks    Try Gemini fallback models after retryable API errors (default: off)
  --out <folder>      Output folder for the generated site (default: ./generated-site)
  --model <model>     Model to use (default: gemini-2.5-flash)
  --api-key <key>     API key, or use GEMINI_API_KEY in .env
  --from-raw <file>   Reprocess a saved raw model response instead of calling an API
  --port <number>     Preferred local server port (default: 4173)
  --no-serve          Generate files without starting the local server
  --no-open           Do not open the browser automatically
  --help              Show this help

Example:
  image-site --screenshots ./screenshot --assets ./extracted --out ./site`;
}

async function loadEnvFile(filePath = path.join(cwd, ".env")) {
  const content = await readFile(filePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (!key) continue;
    if (process.env[key] !== undefined) {
      envKeysSkippedFromFile.add(key);
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function parseArgs(argv) {
  const options = {
    assetFolder: null,
    screenshotFolder: null,
    sourceFile: null,
    sourceBriefChars: DEFAULT_SOURCE_BRIEF_CHARS,
    screenshotRefs: DEFAULT_MAX_SCREENSHOT_REFERENCES,
    assetPreviewCount: 0,
    allowFallbacks: false,
    outDir: path.resolve(cwd, "generated-site"),
    model: null,
    modelWasExplicit: Boolean(process.env.AI_MODEL),
    apiKey: null,
    fromRaw: null,
    port: 4173,
    serve: true,
    open: true
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--screenshots" || arg === "--screenshot") {
      options.screenshotFolder = path.resolve(cwd, requiredValue(argv, ++i, arg));
    } else if (arg === "--assets" || arg === "--extracted") {
      options.assetFolder = path.resolve(cwd, requiredValue(argv, ++i, arg));
    } else if (arg === "--source") {
      options.sourceFile = path.resolve(cwd, requiredValue(argv, ++i, "--source"));
    } else if (arg === "--source-brief-chars") {
      options.sourceBriefChars = Number(requiredValue(argv, ++i, "--source-brief-chars"));
      if (!Number.isInteger(options.sourceBriefChars) || options.sourceBriefChars < 1000) {
        throw new Error("--source-brief-chars must be an integer >= 1000.");
      }
    } else if (arg === "--screenshot-refs") {
      options.screenshotRefs = Number(requiredValue(argv, ++i, "--screenshot-refs"));
      if (!Number.isInteger(options.screenshotRefs) || options.screenshotRefs < 0) {
        throw new Error("--screenshot-refs must be a non-negative integer.");
      }
    } else if (arg === "--asset-previews") {
      options.assetPreviewCount = Number(requiredValue(argv, ++i, "--asset-previews"));
      if (!Number.isInteger(options.assetPreviewCount) || options.assetPreviewCount < 0) {
        throw new Error("--asset-previews must be a non-negative integer.");
      }
    } else if (arg === "--allow-fallbacks") {
      options.allowFallbacks = true;
    } else if (arg === "--out") {
      options.outDir = path.resolve(cwd, requiredValue(argv, ++i, "--out"));
    } else if (arg === "--model") {
      options.model = requiredValue(argv, ++i, "--model");
      options.modelWasExplicit = true;
    } else if (arg === "--api-key") {
      options.apiKey = requiredValue(argv, ++i, "--api-key");
    } else if (arg === "--from-raw") {
      options.fromRaw = path.resolve(cwd, requiredValue(argv, ++i, "--from-raw"));
    } else if (arg === "--port") {
      options.port = Number(requiredValue(argv, ++i, "--port"));
      if (!Number.isInteger(options.port) || options.port < 1) {
        throw new Error("--port must be a positive integer.");
      }
    } else if (arg === "--no-serve") {
      options.serve = false;
      options.open = false;
    } else if (arg === "--no-open") {
      options.open = false;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!options.assetFolder) {
      options.assetFolder = path.resolve(cwd, arg);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  options.model ||= process.env.AI_MODEL || DEFAULT_MODEL;
  options.assetFolder ||= existsSync(path.join(cwd, "extracted"))
    ? path.join(cwd, "extracted")
    : null;
  options.screenshotFolder ||= existsSync(path.join(cwd, "screenshot"))
    ? path.join(cwd, "screenshot")
    : null;
  return options;
}

function requiredValue(argv, index, optionName) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function fingerprintSecret(value) {
  if (!value) return "missing";
  const digest = createHash("sha256").update(String(value)).digest("hex").slice(0, 10);
  const suffix = String(value).slice(-4);
  return `sha256:${digest}, ends:${suffix}`;
}

async function findImages(folder) {
  const entries = await readdir(folder, { withFileTypes: true });
  const images = [];

  for (const entry of entries) {
    const fullPath = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      images.push(...await findImages(fullPath));
    } else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      images.push(fullPath);
    }
  }

  return images.sort((a, b) => a.localeCompare(b));
}

async function findFilesByExtension(folder, extensions) {
  const entries = await readdir(folder, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findFilesByExtension(fullPath, extensions));
    } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

async function prepareContentAssets(imagePaths, imageFolder, outDir) {
  const assetsDir = path.join(outDir, "assets");
  await mkdir(assetsDir, { recursive: true });

  const usedNames = new Set();
  const manifest = [];

  for (const imagePath of imagePaths) {
    const relative = path.relative(imageFolder, imagePath);
    const parsed = path.parse(relative);
    const baseName = sanitizeFileName(`${parsed.dir ? `${parsed.dir}-` : ""}${parsed.name}`) || "image";
    const ext = parsed.ext.toLowerCase();
    let fileName = `${baseName}${ext}`;
    let counter = 2;

    // Keep local asset names stable and readable so the model has a better shot
    // at picking the right image from the manifest.
    while (usedNames.has(fileName)) {
      fileName = `${baseName}-${counter}${ext}`;
      counter += 1;
    }

    usedNames.add(fileName);
    const dimensions = await getImageDimensions(imagePath);
    await copyFile(imagePath, path.join(assetsDir, fileName));
    manifest.push({
      name: path.basename(imagePath),
      sourcePath: relative.split(path.sep).join("/"),
      src: `assets/${fileName}`,
      dimensions,
      diskPath: path.join(assetsDir, fileName),
      role: "content",
      referenceOnly: false
    });
  }

  return manifest;
}

async function prepareScreenshotReferences(imagePaths, imageFolder) {
  const manifest = [];

  for (const imagePath of imagePaths) {
    const relative = path.relative(imageFolder, imagePath);
    manifest.push({
      name: path.basename(imagePath),
      sourcePath: relative.split(path.sep).join("/"),
      src: null,
      dimensions: await getImageDimensions(imagePath),
      diskPath: imagePath,
      role: "screenshot",
      referenceOnly: true
    });
  }

  return manifest;
}

async function commandExists(command) {
  try {
    await execFileAsync("command", ["-v", command], { shell: true });
    return true;
  } catch {
    return false;
  }
}

async function getImageDimensions(filePath) {
  try {
    const { stdout } = await execFileAsync("identify", ["-format", "%w %h", filePath]);
    const [width, height] = stdout.trim().split(/\s+/).map(Number);
    if (Number.isFinite(width) && Number.isFinite(height)) {
      return { width, height };
    }
  } catch {
    // ImageMagick is optional; the original image is still sent if probing fails.
  }
  return null;
}

async function buildReferenceImages(manifest, options = {}) {
  const canSlice = await commandExists("magick");
  const references = [];
  const slicesDir = path.join("/tmp", `image-site-slices-${process.pid}`);
  const maxReferenceImages = options.maxReferenceImages ?? DEFAULT_MAX_SCREENSHOT_REFERENCES;

  for (const image of manifest) {
    if (references.length >= maxReferenceImages) break;

    const dimensions = canSlice ? await getImageDimensions(image.diskPath) : null;
    if (!dimensions || dimensions.height < dimensions.width * 2.5) {
      references.push({ ...image, referenceLabel: image.sourcePath });
      continue;
    }

    await mkdir(slicesDir, { recursive: true });
    // Very tall screenshots tend to be useless as a single image. Slicing them
    // gives Gemini something closer to how a person would inspect the page.
    const sliceHeight = Math.min(1400, Math.max(900, Math.round(dimensions.width * 2.6)));
    const remainingSlots = maxReferenceImages - references.length;
    const sliceCount = Math.min(remainingSlots, Math.ceil(dimensions.height / sliceHeight));

    for (let index = 0; index < sliceCount; index += 1) {
      const y = index * sliceHeight;
      const height = Math.min(sliceHeight, dimensions.height - y);
      const slicePath = path.join(slicesDir, `${sanitizeFileName(image.name)}-${index + 1}.jpg`);

      await execFileAsync("magick", [
        image.diskPath,
        "-crop",
        `${dimensions.width}x${height}+0+${y}`,
        "+repage",
        "-resize",
        `${DEFAULT_REFERENCE_IMAGE_MAX_WIDTH}x>`,
        "-strip",
        "-quality",
        String(DEFAULT_REFERENCE_IMAGE_QUALITY),
        slicePath
      ]);

      references.push({
        ...image,
        diskPath: slicePath,
        referenceLabel: `${image.sourcePath} slice ${index + 1} of ${sliceCount}`
      });
    }
  }

  return references;
}

function buildContentImageReferences(manifest, maxReferenceImages = MAX_ASSET_PREVIEWS) {
  return manifest
    .filter((image) => !image.referenceOnly && VISION_PREVIEW_EXTENSIONS.has(path.extname(image.diskPath).toLowerCase()))
    .slice(0, maxReferenceImages)
    .map((image) => ({
      ...image,
      referenceLabel: `${image.sourcePath} usable asset`
    }));
}

function getMimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function sanitizeFileName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)));
}

function truncateText(value, maxLength) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trim()}…`;
}

function extractAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"));
  return match ? decodeHtmlEntities(match[1]) : "";
}

function stripNoisyHtml(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/\s(?:data-[\w-]+|aria-controls|aria-expanded|aria-haspopup|fetchpriority|decoding|loading|crossorigin)=["'][^"']*["']/gi, "");
}

function buildAssetNameIndex(manifest) {
  const index = new Map();
  for (const image of manifest.filter((item) => !item.referenceOnly)) {
    const keys = [
      path.basename(image.sourcePath || ""),
      path.basename(image.src || "")
    ];

    for (const key of keys) {
      if (key) index.set(key.toLowerCase(), image.src);
    }
  }
  return index;
}

function inferAssetKind(image) {
  const name = `${image.sourcePath || ""} ${image.name || ""}`.toLowerCase();
  const dimensions = image.dimensions || {};
  if (/\blogo|favicon|badge|icon|svg\b/.test(name)) return "logo/icon";
  if (/\bpeople|instructor|mentor|person|carousel|thumbnail|podcast|news|hq\b/.test(name)) return "photo/thumbnail";
  if (/\bbg|background|relevance|why|platform|support|lifetime|curricullum|projects|usp\b/.test(name)) return "section visual/background";
  if (/\bstar|ticker|logos|collab|enterprise\b/.test(name)) return "decorative/logo strip";
  if (dimensions.width && dimensions.height && dimensions.width > dimensions.height * 3) return "wide strip";
  if (dimensions.width && dimensions.height && dimensions.height > dimensions.width * 1.4) return "tall section visual";
  return "content image";
}

function mapSourceAsset(src, assetNameIndex) {
  const cleanSrc = decodeHtmlEntities(src).split("?")[0].split("#")[0];
  const baseName = path.basename(cleanSrc).toLowerCase();
  return assetNameIndex.get(baseName) || "";
}

function extractMetaBrief(html) {
  const title = decodeHtmlEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const description = decodeHtmlEntities(
    html.match(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i)?.[1] ||
    html.match(/<meta\b[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i)?.[1] ||
    ""
  );

  return [
    title ? `Title: ${truncateText(title, 180)}` : "",
    description ? `Description: ${truncateText(description, 260)}` : ""
  ].filter(Boolean);
}

function extractDesignTokenBrief(html) {
  const variableMatches = [...html.matchAll(/--[a-z0-9-]+\s*:\s*[^;{}]+/gi)]
    .map((match) => match[0].replace(/\s+/g, " ").trim())
    .filter((token) => /--(brand|primary|neutral|global|font|radius|spacing|shadow|background|border|muted|foreground|cta)/i.test(token));
  return [...new Set(variableMatches)].slice(0, 80);
}

function extractAnimationBrief(html) {
  const rows = [];
  const seen = new Set();
  const animationPattern = /<([a-z0-9-]+)\b[^>]*(?:class|aria-label|data-track-section|data-click-type)=["'][^"']*(?:animate|transition|duration|carousel|marquee|sticky|fixed|video|play|slider|accordion|dropdown|sheet|modal|tab|pulse|spin|hover|group)[^"']*["'][^>]*>/gi;

  for (const match of html.matchAll(animationPattern)) {
    const tag = match[1].toLowerCase();
    const rawTag = match[0];
    const className = extractAttribute(rawTag, "class")
      .split(/\s+/)
      .filter((part) => /(animate|transition|duration|carousel|marquee|sticky|fixed|video|play|slider|accordion|dropdown|sheet|modal|tab|pulse|spin|hover|group|overflow|translate|transform)/i.test(part))
      .slice(0, 14)
      .join(" ");
    const label = extractAttribute(rawTag, "aria-label");
    const section = extractAttribute(rawTag, "data-track-section");
    const clickType = extractAttribute(rawTag, "data-click-type");
    const row = `<${tag}>${section ? ` section=${section}` : ""}${clickType ? ` action=${clickType}` : ""}${label ? ` label="${truncateText(label, 80)}"` : ""}${className ? ` classes="${className}"` : ""}`;
    if (!seen.has(row)) {
      seen.add(row);
      rows.push(row);
    }
    if (rows.length >= 80) break;
  }

  const inferred = [];
  const lower = html.toLowerCase();
  if (/\bcarousel|marquee|ticker\b/.test(lower)) inferred.push("horizontal logo/person carousels or marquee strips");
  if (/\bsticky|fixed\b/.test(lower)) inferred.push("sticky top/program nav and bottom CTA behavior");
  if (/\baccordion|tab|data-state|aria-expanded\b/.test(lower)) inferred.push("tab/dropdown/accordion states");
  if (/\bvideo|youtube|play\b/.test(lower)) inferred.push("video thumbnail cards with play overlays");
  if (/\banimate-pulse|animate-spin\b/.test(lower)) inferred.push("loading animation exists in source but should not be recreated as page content");

  return [
    ...inferred.map((item) => `Inferred: ${item}`),
    ...rows
  ];
}

function extractImageBrief(html, assetNameIndex) {
  const imageTags = [...html.matchAll(/<(?:img|source|link)\b[^>]*(?:src|srcset|href)=["'][^"']+["'][^>]*>/gi)];
  const rows = [];
  const seen = new Set();

  for (const match of imageTags) {
    const tag = match[0];
    const src = extractAttribute(tag, "src") || extractAttribute(tag, "href") || extractAttribute(tag, "srcset").split(/\s|,/)[0];
    if (!src || !/\.(png|jpe?g|webp|gif|avif|svg|ico)(\?|#|$)/i.test(src)) continue;

    const localAsset = mapSourceAsset(src, assetNameIndex);
    const baseName = path.basename(src.split("?")[0]);
    const alt = extractAttribute(tag, "alt");
    const width = extractAttribute(tag, "width");
    const height = extractAttribute(tag, "height");
    const row = `${baseName}${localAsset ? ` -> ${localAsset}` : ""}${alt ? ` | alt: ${truncateText(alt, 80)}` : ""}${width || height ? ` | size: ${width || "?"}x${height || "?"}` : ""}`;
    if (!seen.has(row)) {
      seen.add(row);
      rows.push(row);
    }
    if (rows.length >= 90) break;
  }

  return rows;
}

function extractStructureBrief(cleanHtml) {
  const rows = [];
  const seen = new Set();
  const importantTags = /<(header|nav|main|section|article|aside|footer|h[1-3]|a|button|img)\b[^>]*>/gi;

  for (const match of cleanHtml.matchAll(importantTags)) {
    const tag = match[1].toLowerCase();
    const rawTag = match[0];
    const id = extractAttribute(rawTag, "id");
    const className = extractAttribute(rawTag, "class")
      .split(/\s+/)
      .filter((part) => /^(sticky|fixed|grid|flex|container|max-|bg-|text-|border|rounded|shadow|hero|program|story|footer|nav|section|card|cta)/.test(part))
      .slice(0, 8)
      .join(" ");
    const rawHref = tag === "a" ? extractAttribute(rawTag, "href") : "";
    const href = rawHref && !/^https?:\/\//i.test(rawHref) ? rawHref : "";
    const src = tag === "img" ? path.basename((extractAttribute(rawTag, "src") || "").split("?")[0]) : "";
    const row = `<${tag}${id ? ` id="${id}"` : ""}${className ? ` class="${className}"` : ""}${href ? ` href="${href}"` : ""}${src ? ` src="${src}"` : ""}>`;
    if (!seen.has(row)) {
      seen.add(row);
      rows.push(row);
    }
    if (rows.length >= 160) break;
  }

  return rows;
}

function isNoisyTextLine(line) {
  return (
    line.length < 2 ||
    /^(true|false|null|\$undefined|\$L[0-9a-f]+|\d+)$/.test(line) ||
    /\b(sign in to confirm|not a bot|captcha|cloudflare|challenge|notifications alt\+t|animate-spin|bailout_to_client_side_rendering|googletagmanager|google-analytics|clarity\.ms)\b/i.test(line) ||
    /^[{}[\]":,$._\-0-9a-f\s]+$/i.test(line)
  );
}

function extractTextBrief(cleanHtml) {
  const textHtml = cleanHtml
    .replace(/<(br|p|div|section|article|header|footer|nav|li|ul|ol|h[1-6]|button|a)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|nav|li|ul|ol|h[1-6]|button|a)>/gi, "\n")
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const alt = extractAttribute(tag, "alt");
      const src = path.basename((extractAttribute(tag, "src") || "").split("?")[0]);
      return `\n[image${src ? `: ${src}` : ""}${alt ? ` alt="${alt}"` : ""}]\n`;
    })
    .replace(/<[^>]+>/g, " ");

  const seen = new Set();
  const lines = [];
  for (const rawLine of decodeHtmlEntities(textHtml).split(/\n+/)) {
    const line = truncateText(rawLine, 220);
    const normalized = line.toLowerCase();
    if (isNoisyTextLine(line) || seen.has(normalized)) continue;
    seen.add(normalized);
    lines.push(line);
    if (lines.length >= 220) break;
  }

  return lines;
}

async function buildSourceBrief(sourceFile, manifest, maxChars = DEFAULT_SOURCE_BRIEF_CHARS) {
  if (!sourceFile) return "";

  const html = await readFile(sourceFile, "utf8");
  const assetNameIndex = buildAssetNameIndex(manifest);
  const cleanHtml = stripNoisyHtml(html);
  const meta = extractMetaBrief(html);
  const designTokens = extractDesignTokenBrief(html);
  const images = extractImageBrief(html, assetNameIndex);
  const animations = extractAnimationBrief(cleanHtml);
  const structure = extractStructureBrief(cleanHtml);
  const text = extractTextBrief(cleanHtml);

  // We do not send raw page source. We turn it into a compact brief so the
  // model gets structure and copy without drowning in framework noise.
  return [
    `Source file: ${path.basename(sourceFile)} (${html.length} bytes raw, cleaned and summarized below)`,
    "",
    meta.length ? `Metadata:\n${meta.map((line) => `- ${line}`).join("\n")}` : "",
    designTokens.length ? `Design tokens and CSS variables:\n${designTokens.map((line) => `- ${line}`).join("\n")}` : "",
    images.length ? `Image references from source, mapped to local assets when possible:\n${images.map((line) => `- ${line}`).join("\n")}` : "",
    animations.length ? `Motion and interaction clues:\n${animations.map((line) => `- ${line}`).join("\n")}` : "",
    structure.length ? `Structural outline:\n${structure.map((line) => `- ${line}`).join("\n")}` : "",
    text.length ? `Deduped visible text and labels:\n${text.map((line) => `- ${line}`).join("\n")}` : ""
  ].filter(Boolean).join("\n\n").slice(0, maxChars);
}

function buildSitePrompt(manifest, sourceBrief = "") {
  const usableAssets = manifest.filter((image) => !image.referenceOnly);
  const referenceOnlyAssets = manifest.filter((image) => image.referenceOnly);

  return `Reverse-engineer the attached image reference into a polished static website.

Return exactly three files using this marker format:
---FILE:index.html---
complete index.html content
---FILE:styles.css---
complete styles.css content
---FILE:script.js---
complete script.js content
---END---

Goal:
- Make the generated website look as close as possible to the reference image when opened in a browser.
- If the image is a full-page website screenshot, recreate that website as real HTML/CSS sections. Do not simply place the screenshot on the page.
- Match the visual system: header/nav, hero, CTA bars, grids, card shapes, spacing, colors, typography scale, section rhythm, footer, and responsive behavior.

Rules:
- indexHtml must link to ./styles.css and ./script.js.
- Target the desktop screenshot first. Use a fixed desktop-quality composition with responsive safeguards, but do not simplify the desktop layout for mobile.
- Do not use the reference screenshot as the main page content or as a full-page background.
- Do not use reference-only screenshot asset paths anywhere in indexHtml, stylesCss, or scriptJs.
- Use the screenshot references only for layout, spacing, colors, typography, section order, and visible text.
- When the source brief and screenshot disagree, trust the screenshot for what is visible and trust the source for exact copy/assets.
- Use the cleaned page source brief for the real section hierarchy, copy, class/style clues, image intent, and design tokens.
- Ignore source content that is clearly loading UI, bot checks, cookie/consent prompts, analytics, hidden experiments, captcha/challenge text, or framework hydration data.
- Use the extracted local content assets when the cloned page needs real images, logos, thumbnails, portraits, backgrounds, or decorative artwork.
- You may choose extracted assets by their file names and dimensions from the manifest even when their binary image previews were not attached.
- Match source image references to local assets by similar file names, alt text, dimensions, and semantic names.
- If there are no usable content assets, recreate everything with HTML/CSS shapes, text, cards, gradients, and placeholders.
- Do not include markdown fences.
- Do not wrap the response in backticks or JSON.
- The file markers must appear exactly as shown.
- Do not use external CSS or JS libraries.
- Do not use any external URLs, placeholder services, CDN assets, web fonts, or remote images.
- Keep links self-contained. Use "#", local hash links, or inert buttons instead of external website/social/blog/app-store URLs.
- Use CSS shapes, gradients, initials, and text blocks instead of placeholder images.
- Do not output placeholder comments or unfinished scaffolding such as "content would go here", "other cards hidden", TODOs, or empty placeholder blocks.
- Recreate all visibly repeated items as static HTML: nav links, tabs, feature cards, story cards, podcast/news/blog cards, mentor rows, how-it-works rows, stats, footer columns, and sticky CTA.
- Preserve the full-page vertical rhythm from the screenshot: compact top navigation, centered white hero, thin blue CTA strip, deep blue feature band, alternating white/light-gray sections, blue right-side program card, masonry-like story grid, image-led how-it-works rows, stats/news/footer, and bottom CTA.
- Recreate motion hinted by source classes and section names with lightweight local CSS/JS only: sticky nav/bottom CTA, hover transitions, tab switching, dropdown states, autoplaying marquee/logo/person strips, slow carousel track motion, play-overlay affordances, and subtle reveal/fade/slide effects.
- Do not recreate loading spinners, skeleton pulse placeholders, bot/captcha challenges, analytics events, external video embeds, or framework hydration behavior.
- Respect prefers-reduced-motion by disabling nonessential animation in CSS.
- Do not describe the task or mention AI/reference images in the visible page.
- Make the first screen the actual website, not an explainer about generation.
- Analyze the attached images for layout, color, typography mood, subject matter, hierarchy, spacing, and visual style.
- Treat each run independently. Do not reuse brand names, course content, section names, or business domain details from examples or previous outputs unless they are visible in the current attached images.
- Recreate the image's visible text as much as possible where readable. If text is too small, use plausible replacement text with matching length and tone.
- Build a long-form page when the reference is long. Include all major visible sections instead of only a hero.
- Keep the page dense like the screenshot. Avoid inflated spacing, oversized generic cards, or turning compact sections into broad marketing blocks.
- Prefer precise CSS layout over decorative gimmicks: max-width containers, thin borders, compact cards, blue CTA bands, image-like placeholders, tabs, accordions, metric cards, story grids, FAQ rows, and footer columns when visible.
- Use restrained, production-quality HTML, CSS, and JS. JS can be tiny, only for tabs/accordion/carousel controls if needed.

Quality bar:
- The output should not look like a generic template.
- The output should not be a single image pasted into a page.
- The output should feel like a faithful frontend recreation of the screenshot.

Usable local content assets:
${JSON.stringify(usableAssets.map((image) => ({
  name: image.name,
  sourcePath: image.sourcePath,
  src: image.src,
  dimensions: image.dimensions,
  kind: inferAssetKind(image)
})), null, 2)}

Reference-only screenshot images, forbidden as page assets:
${JSON.stringify(referenceOnlyAssets.map(({ name, sourcePath, dimensions }) => ({ name, sourcePath, dimensions })), null, 2)}

Cleaned page source brief:
${sourceBrief || "No saved page source was provided."}`;
}

function stripMarkdownFence(text) {
  return String(text)
    .trim()
    .replace(/^```(?:html|text|txt|json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

function findMarker(output, fileName) {
  const pattern = new RegExp(`---\\s*FILE\\s*:\\s*${fileName.replace(".", "\\.")}\\s*---`, "i");
  const match = pattern.exec(output);
  if (!match) return null;
  return {
    start: match.index,
    end: match.index + match[0].length
  };
}

function extractGeneratedFiles(text) {
  const output = stripMarkdownFence(text);
  const indexMarker = findMarker(output, "index.html");
  const stylesMarker = findMarker(output, "styles.css");
  const scriptMarker = findMarker(output, "script.js");

  if (indexMarker && stylesMarker && scriptMarker) {
    const endMarkerMatch = /---\s*END\s*---/i.exec(output.slice(scriptMarker.end));
    const scriptEnd = endMarkerMatch
      ? scriptMarker.end + endMarkerMatch.index
      : output.length;

    return {
      indexHtml: output.slice(indexMarker.end, stylesMarker.start).trim(),
      stylesCss: output.slice(stylesMarker.end, scriptMarker.start).trim(),
      scriptJs: output.slice(scriptMarker.end, scriptEnd).trim()
    };
  }

  if (indexMarker && stylesMarker) {
    return {
      indexHtml: output.slice(indexMarker.end, stylesMarker.start).trim(),
      stylesCss: output.slice(stylesMarker.end).trim(),
      scriptJs: "// No interactive behavior was generated."
    };
  }

  const cleaned = stripMarkdownFence(text);
  if (!cleaned.startsWith("{") && !cleaned.startsWith("[")) {
    const preview = cleaned.slice(0, 160).replace(/\s+/g, " ");
    throw new Error(`Model response did not contain all file markers. Response starts: ${preview}`);
  }

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw error;
  }
}

async function saveRawModelResponse(outDir, text) {
  if (!outDir) return;
  await writeFile(path.join(outDir, ".last-model-response.txt"), String(text), "utf8").catch(() => {});
}

function validateGeneratedSite(generated, manifest = []) {
  for (const key of ["indexHtml", "stylesCss", "scriptJs"]) {
    if (typeof generated[key] !== "string" || generated[key].trim().length < 10) {
      throw new Error(`AI response did not include a usable ${key} string.`);
    }
  }

  const combinedOutput = `${generated.indexHtml}\n${generated.stylesCss}\n${generated.scriptJs}`;
  const networkUrlMatch = combinedOutput.match(/https?:\/\/(?!www\.w3\.org\/2000\/svg\b)[^\s"'<>)}]+/i);
  if (networkUrlMatch) {
    throw new Error("Generated site contains external URLs. The site must be self-contained.");
  }

  for (const image of manifest) {
    if (image.referenceOnly && image.src && combinedOutput.includes(image.src)) {
      throw new Error(`Generated site tried to paste reference-only screenshot asset: ${image.src}`);
    }

    if (image.referenceOnly && combinedOutput.includes(`screenshot/${image.sourcePath}`)) {
      throw new Error(`Generated site tried to reference screenshot input directly: screenshot/${image.sourcePath}`);
    }
  }
}

function hasBalancedCssBraces(css) {
  let depth = 0;
  for (const char of String(css)) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function needsStructuralFallback(generated) {
  const css = String(generated.stylesCss || "");
  const html = String(generated.indexHtml || "");
  if (css.trim().length < 1800) return true;
  if (!hasBalancedCssBraces(css)) return true;

  const expectedSelectors = [
    ".container",
    ".btn",
    ".hero",
    ".hero-section",
    ".section-title",
    ".feature-card",
    ".story-card",
    ".footer"
  ];
  const matchingSelectors = expectedSelectors.filter((selector) => css.includes(selector)).length;
  const generatedSections = (html.match(/<section\b/gi) || []).length;

  return matchingSelectors < 4 || generatedSections < 3;
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

function extractAltText(tag) {
  return tag.match(/\balt=["']([^"']*)["']/i)?.[1] || "Visual";
}

function stripNetworkUrls(value, replacement = "#") {
  return String(value).replace(/https?:\/\/(?!www\.w3\.org\/2000\/svg\b)[^\s"'<>)}]+/gi, replacement);
}

function sanitizeExternalHtmlReferences(html) {
  return stripNetworkUrls(
    String(html)
      .replace(/<link\b[^>]*rel=["'](?:canonical|preconnect|dns-prefetch|preload)["'][^>]*>/gi, "")
      .replace(/<link\b[^>]*href=["']https?:\/\/[^"']+["'][^>]*>/gi, "")
      .replace(/<script\b[^>]*src=["']https?:\/\/[^"']+["'][^>]*>\s*<\/script>/gi, "")
      .replace(/\s(href|action)=["']https?:\/\/[^"']+["']/gi, (_, attr) => ` ${attr}="#"`)
      .replace(/\ssrcset=["']https?:\/\/[^"']+["']/gi, "")
  );
}

function removePlaceholderComments(html) {
  return String(html).replace(/<!--\s*(?:TODO|placeholder|.*would go here.*|.*hidden by default.*|.*dropdown content.*)\s*-->/gi, "");
}

function postProcessGeneratedSite(generated) {
  let indexHtml = String(generated.indexHtml)
    .replace(/<img\b[^>]*src=["']https?:\/\/[^"']+["'][^>]*>/gi, (tag) => {
      const alt = escapeAttribute(extractAltText(tag));
      return `<div class="generated-visual" role="img" aria-label="${alt}"><span>${alt}</span></div>`;
    })
    .replace(/<source\b[^>]*srcset=["']https?:\/\/[^"']+["'][^>]*>/gi, "")
    .replace(/<video\b[^>]*src=["']https?:\/\/[^"']+["'][^>]*>/gi, "")
    .replace(/<audio\b[^>]*src=["']https?:\/\/[^"']+["'][^>]*>/gi, "");

  indexHtml = sanitizeExternalHtmlReferences(indexHtml)
    .replace(/<div\b[^>]*class=["'][^"']*placeholder[^"']*["'][^>]*>\s*<\/div>/gi, "")
    .replace(/<section\b[^>]*class=["'][^"']*(?:bot|captcha|challenge)[^"']*["'][^>]*>[\s\S]*?<\/section>/gi, "")
    .replace(/<i\b[^>]*>\s*<\/i>/gi, '<span class="icon-dot" aria-hidden="true"></span>');
  indexHtml = removePlaceholderComments(indexHtml);

  let stylesCss = generated.stylesCss
    .replace(/@import\s+url\(["']?https?:\/\/[^"')]+["']?\)\s*;?/gi, "")
    .replace(/url\(["']?https?:\/\/[^"')]+["']?\)/gi, "none");

  stylesCss = stripNetworkUrls(stylesCss, "#");
  const scriptJs = stripNetworkUrls(generated.scriptJs, "#");

  const supportCss = `

/* Generated structural fallback: keeps partial model CSS looking like a real landing page. */
:root {
  --primary-blue: #005bff;
  --deep-blue: #061f55;
  --ink: #090b12;
  --muted: #5b6472;
  --line: #dfe5ef;
  --soft: #f5f7fb;
  --white: #ffffff;
}

* { box-sizing: border-box; }

html { scroll-behavior: smooth; }

body {
  margin: 0;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--ink);
  background: var(--white);
  line-height: 1.5;
}

a { color: inherit; text-decoration: none; }

img { max-width: 100%; display: block; }

.container {
  width: min(1180px, calc(100% - 40px));
  margin: 0 auto;
}

.header {
  position: sticky;
  top: 0;
  z-index: 10;
  background: rgba(255, 255, 255, 0.96);
  border-bottom: 1px solid var(--line);
}

.header-content,
.main-nav ul,
.header-actions,
.hero-actions,
.cta-bar-content,
.tools-row,
.tool-logos,
.footer-bottom {
  display: flex;
  align-items: center;
}

.header-content { min-height: 58px; justify-content: space-between; gap: 22px; }
.logo .generated-visual { width: 96px; min-height: 28px; border-radius: 3px; font-size: 0.72rem; }
.main-nav ul { gap: 26px; padding: 0; margin: 0; list-style: none; font-size: 0.82rem; font-weight: 650; }
.header-actions { gap: 10px; }
.menu-toggle { display: none; }

.btn {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 10px 18px;
  border: 1px solid transparent;
  font-size: 0.78rem;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0;
  cursor: pointer;
}

.btn-primary { background: var(--primary-blue); color: #fff; }
.btn-outline { background: #fff; color: var(--deep-blue); border-color: var(--deep-blue); }
.btn-login { color: var(--ink); text-transform: none; font-weight: 700; }

.hero {
  min-height: 520px;
  display: grid;
  place-items: start center;
  padding: 70px 0 130px;
  color: #fff;
  text-align: center;
  background:
    radial-gradient(circle at 50% 100%, rgba(255,255,255,0.9), transparent 32%),
    linear-gradient(180deg, #05a5b4 0%, #0163e8 48%, #f8fbff 100%);
}

.hero-content { max-width: 860px; }
.hero-breadcrumb, .section-subtitle { margin: 0 0 12px; font-size: 0.72rem; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
.hero h1 { margin: 0 0 18px; font-size: clamp(2.6rem, 7vw, 4.9rem); line-height: 0.98; letter-spacing: 0; }
.hero-description { max-width: 720px; margin: 0 auto 26px; color: rgba(255,255,255,0.9); }
.hero-actions { justify-content: center; gap: 16px; flex-wrap: wrap; }

.features-grid-section { margin-top: -86px; padding-bottom: 70px; background: transparent; }
.features-grid, .ai-os-features-grid, .service-grid, .testimonial-grid, .news-grid, .project-cards-grid, .instructors-grid, .stories-grid, .footer-grid {
  display: grid;
  gap: 18px;
}
.features-grid { grid-template-columns: repeat(3, 1fr); }
.feature-card, .service-card, .testimonial-card, .news-card, .project-card, .instructor-card, .story-card, .footer-section {
  background: #fff;
  border: 1px solid var(--line);
  padding: 24px;
  box-shadow: 0 16px 42px rgba(6, 31, 85, 0.08);
}
.feature-card h3, .project-card h3, .news-card h3 { margin: 10px 0 8px; font-size: 1rem; }
.feature-card p, .project-card p, .news-card p, .section-description { color: var(--muted); }

section:not(.hero):not(.features-grid-section):not(.cta-bar) { padding: 78px 0; }
section h2 { max-width: 780px; margin: 0 0 12px; font-size: clamp(1.85rem, 4vw, 3.4rem); line-height: 1.06; letter-spacing: 0; }

.cta-bar {
  margin: 42px 0;
  padding: 14px 0;
  background: var(--deep-blue);
  color: #fff;
}
.cta-bar-content { justify-content: space-between; gap: 20px; font-size: 0.86rem; }
.cta-bar .btn { min-height: 30px; padding: 8px 16px; }

.who-it-is-for-content,
.ai-content,
.pricing-content,
.certificate-content,
.how-it-works-content {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 0.82fr);
  gap: 36px;
  align-items: start;
}

.tab-buttons, .curriculum-tabs, .project-tabs, .course-tabs, .faq-layout {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.tab-button, .curriculum-tab-button, .project-tab-button, .course-tab {
  border: 1px solid var(--line);
  background: #f7f9fd;
  padding: 11px 18px;
  font-weight: 800;
}
.active { border-color: var(--primary-blue); background: #eaf1ff; }
.tab-pane, .curriculum-content, .faq-item {
  border: 1px solid var(--line);
  background: #fff;
  padding: 24px;
}
.tab-pane:not(.active) { display: none; }

.ai-os-section,
.outcomes-section,
.pricing-section {
  background: var(--primary-blue);
  color: #fff;
}
.ai-os-section .section-description,
.outcomes-section .section-description,
.pricing-section .section-description { color: rgba(255,255,255,0.82); }
.ai-os-features-grid { grid-template-columns: repeat(4, 1fr); margin-top: 34px; }
.ai-os-section .feature-card { color: var(--ink); min-height: 210px; }
.tools-row { gap: 20px; margin-top: 28px; flex-wrap: wrap; }
.tool-logos { gap: 14px; flex-wrap: wrap; }

.curriculum-tabs { margin: 24px 0; }
.curriculum-tab-button { flex: 1 1 220px; }
.curriculum-tab-button span { display: block; margin-top: 4px; color: var(--muted); font-size: 0.72rem; font-weight: 500; }
.module-list, .faq-list { display: grid; gap: 10px; }
.module-item, .faq-item {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid var(--line);
  padding: 16px 0;
}

.project-cards-grid, .instructors-grid { grid-template-columns: repeat(2, 1fr); }
.stories-grid { grid-template-columns: repeat(3, 1fr); }
.outcome-stats, .pricing-card, .news-grid, .blog-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
.stat-card, .pricing-card > *, .blog-card {
  background: #fff;
  color: var(--ink);
  border: 1px solid var(--line);
  padding: 22px;
}

.footer {
  padding: 64px 0 30px;
  background: #f7f8fb;
  color: var(--ink);
}
.footer-grid { grid-template-columns: 1.3fr repeat(4, 1fr); }
.footer ul { padding: 0; margin: 0; list-style: none; display: grid; gap: 8px; color: var(--muted); }

@media (max-width: 900px) {
  .main-nav, .header-actions { display: none; }
  .menu-toggle { display: inline-grid; place-items: center; }
  .features-grid, .ai-os-features-grid, .project-cards-grid, .instructors-grid, .stories-grid, .outcome-stats, .pricing-card, .news-grid, .blog-grid, .footer-grid {
    grid-template-columns: 1fr;
  }
  .who-it-is-for-content, .ai-content, .pricing-content, .certificate-content, .how-it-works-content {
    grid-template-columns: 1fr;
  }
  .hero { padding-top: 52px; }
}

/* Generated fallback visuals: replaces external placeholder/icon assets. */
.generated-visual {
  min-height: 120px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border: 1px solid rgba(3, 22, 61, 0.12);
  background:
    linear-gradient(135deg, rgba(0, 94, 255, 0.18), rgba(5, 23, 65, 0.96)),
    repeating-linear-gradient(45deg, rgba(255,255,255,0.10) 0 10px, transparent 10px 20px);
  color: #fff;
  text-align: center;
  font-weight: 700;
}

.generated-visual span {
  max-width: 80%;
  line-height: 1.3;
}

.icon-dot {
  width: 18px;
  height: 18px;
  display: inline-grid;
  place-items: center;
  vertical-align: -3px;
}

.icon-dot::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: currentColor;
  box-shadow: 0 0 0 4px rgba(0, 94, 255, 0.12);
}
`;

  if (needsStructuralFallback({ ...generated, stylesCss, indexHtml }) && !stylesCss.includes("Generated structural fallback")) {
    stylesCss += supportCss;
  }

  return {
    indexHtml,
    stylesCss,
    scriptJs
  };
}

function isRateLimitError(error) {
  return /\b(400|403|404|429|503)\b|rate limit|quota|not found|permission|high demand|unavailable|file markers|reference-only screenshot|usable indexHtml|usable stylesCss|usable scriptJs/i.test(error?.message || "");
}

function parseRetryDelayMs(message) {
  const retryInfoMatch = String(message).match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (retryInfoMatch) return Math.ceil(Number(retryInfoMatch[1]) * 1000);

  const plainMatch = String(message).match(/retry in\s+(\d+(?:\.\d+)?)s/i);
  if (plainMatch) return Math.ceil(Number(plainMatch[1]) * 1000);

  return null;
}

function isQuotaExhaustedError(error) {
  return /\b(429|RESOURCE_EXHAUSTED|quota exceeded|free_tier|rate-limits|retryDelay)\b/i.test(error?.message || "");
}

function buildQuotaError(provider, status, bodyText) {
  const retryMs = parseRetryDelayMs(bodyText);
  const retryText = retryMs ? ` Retry after about ${Math.ceil(retryMs / 1000)}s.` : "";
  const zeroLimitNote = /limit:\s*0\b/i.test(bodyText)
    ? ` ${provider} is reporting a quota limit of 0 for this model/project, which usually means model access or project-level quota is not actually available yet.`
    : "";
  return new Error(`${provider} quota/rate limit hit (${status}).${retryText}${zeroLimitNote} Not retrying other models unless --allow-fallbacks is set.\n${bodyText}`);
}

async function makeGeminiParts(manifest, referenceImages, sourceBrief = "") {
  const parts = [{ text: buildSitePrompt(manifest, sourceBrief) }];

  for (const image of referenceImages) {
    const imageBuffer = await readFile(image.diskPath);
    const mimeType = getMimeType(image.diskPath);
    const assetInstruction = image.referenceOnly
      ? "This is a screenshot reference only. Use it for visual analysis, layout, text, and section order. It is forbidden to use this image as a page asset."
      : `Use local asset path ${image.src} in generated HTML/CSS only if you need to display this content image.`;

    parts.push({ text: `Reference image: ${image.referenceLabel}. ${assetInstruction}` });
    parts.push({
      inline_data: {
        mime_type: mimeType,
        data: imageBuffer.toString("base64")
      }
    });
  }

  return parts;
}

function summarizeGeminiParts(parts) {
  let textChars = 0;
  let imageCount = 0;
  let base64Chars = 0;

  for (const part of parts) {
    if (typeof part.text === "string") {
      textChars += part.text.length;
    }
    if (part.inline_data?.data) {
      imageCount += 1;
      base64Chars += part.inline_data.data.length;
    }
  }

  return {
    textChars,
    imageCount,
    base64Chars,
    approxImageBytes: Math.floor((base64Chars * 3) / 4)
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFetchFailureDetail(error) {
  const cause = error?.cause;
  const causeErrors = Array.isArray(cause?.errors)
    ? cause.errors.map((item) => [item?.code, item?.message].filter(Boolean).join(": ")).filter(Boolean)
    : [];
  const causeMessage = [
    cause?.code,
    cause?.name,
    cause?.message
  ].filter(Boolean).join(": ");
  return causeErrors[0] || causeMessage || error?.message || String(error);
}

function isTransientFetchFailure(error) {
  const detail = getFetchFailureDetail(error);
  return /\b(AbortError|aborted|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|socket|timeout|network)\b/i.test(detail);
}

async function safeFetch(provider, url, options, maxAttempts = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);

    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      lastError = error;
      const detail = getFetchFailureDetail(error);
      const shouldRetry = attempt < maxAttempts && isTransientFetchFailure(error);
      if (!shouldRetry) {
        throw new Error(`${provider} fetch failed before receiving an HTTP response: ${detail}`);
      }

      const delay = 1500 * attempt;
      console.warn(`${provider} fetch attempt ${attempt} failed before HTTP response (${detail}); retrying in ${delay}ms...`);
      await sleep(delay);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`${provider} fetch failed before receiving an HTTP response: ${getFetchFailureDetail(lastError)}`);
}

function isFetchBeforeResponseError(error) {
  return /fetch failed before receiving an HTTP response/i.test(error?.message || "");
}

function isRetryableGenerationError(error) {
  return isFetchBeforeResponseError(error) || isRateLimitError(error);
}

async function generateWithGemini({ manifest, referenceImages, sourceBrief, model, apiKey, outDir }) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("Gemini needs an API key. Paste it into GEMINI_API_KEY in .env or pass --api-key.");
  }
  console.log(`Gemini key: ${fingerprintSecret(key)}${apiKey ? " (--api-key)" : envKeysSkippedFromFile.has("GEMINI_API_KEY") ? " (environment variable; .env value was ignored)" : " (env/.env)"}.`);

  // Log a payload breakdown because Gemini quota issues are much easier to debug
  // when we can see whether the weight is mostly text, screenshots, or both.
  const parts = await makeGeminiParts(manifest, referenceImages, sourceBrief);
  const partSummary = summarizeGeminiParts(parts);
  const body = JSON.stringify({
    system_instruction: {
      parts: [{ text: "You are an expert frontend engineer and visual designer. Return only the requested file-marker format." }]
    },
    contents: [
      {
        role: "user",
        parts
      }
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: MAX_OUTPUT_TOKENS
    }
  });

  console.log(`Gemini request payload: ${formatBytes(Buffer.byteLength(body))}.`);
  console.log(`Gemini payload breakdown: prompt text ${partSummary.textChars.toLocaleString()} chars, ${partSummary.imageCount} image part(s), approx inline image bytes ${formatBytes(partSummary.approxImageBytes)}.`);
  const response = await safeFetch("Gemini", `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": key
    },
    body
  });

  if (!response.ok) {
    const bodyText = await response.text();
    if (response.status === 429) throw buildQuotaError("Gemini", response.status, bodyText);
    throw new Error(`Gemini request failed (${response.status}): ${bodyText}`);
  }

  const payload = await response.json();
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n");
  if (!text) throw new Error("Gemini returned no text.");
  await saveRawModelResponse(outDir, text);
  return extractGeneratedFiles(text);
}

async function generateWithFallback(options) {
  const modelQueue = options.modelWasExplicit || !options.allowFallbacks
    ? [options.model]
    : [options.model, ...FALLBACK_MODELS.filter((model) => model !== options.model)];

  console.log(`Gemini model queue: ${modelQueue.join(" -> ")}`);

  let lastError = null;
  for (let index = 0; index < modelQueue.length; index += 1) {
    const model = modelQueue[index];
    try {
      const generated = postProcessGeneratedSite(await generateWithGemini({ ...options, model }));
      validateGeneratedSite(generated, options.manifest);
      return generated;
    } catch (error) {
      lastError = error;
      const nextModel = modelQueue[index + 1];
      if (isQuotaExhaustedError(error) && !options.allowFallbacks) {
        throw error;
      }
      if (!nextModel || !isRetryableGenerationError(error)) {
        throw error;
      }

      console.warn(`Gemini could not use ${model}; retrying with ${nextModel}...`);
    }
  }

  throw lastError;
}

async function saveGeneratedSite(outDir, generated, manifest) {
  generated = postProcessGeneratedSite(generated);
  validateGeneratedSite(generated, manifest);
  await writeFile(path.join(outDir, "index.html"), generated.indexHtml, "utf8");
  await writeFile(path.join(outDir, "styles.css"), generated.stylesCss, "utf8");
  await writeFile(path.join(outDir, "script.js"), generated.scriptJs, "utf8");
}

function openBrowser(url) {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function listen(server, preferredPort) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferredPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  }).catch((error) => {
    if (error.code !== "EADDRINUSE") throw error;
    return listen(server, 0);
  });
}

async function serveStatic(filePath, response) {
  const ext = path.extname(filePath).toLowerCase();
  response.writeHead(200, { "content-type": MIME_TYPES[ext] || "application/octet-stream" });
  createReadStream(filePath).pipe(response);
}

function makeStaticServer(outDir) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      const requestedPath = decodeURIComponent(url.pathname) === "/" ? "/index.html" : decodeURIComponent(url.pathname);
      const resolved = path.resolve(outDir, `.${requestedPath}`);

      if (!resolved.startsWith(outDir + path.sep) && resolved !== outDir) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }

      const fileStat = await stat(resolved).catch(() => null);
      if (!fileStat?.isFile()) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }

      await serveStatic(resolved, response);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error?.stack || String(error));
    }
  });
}

async function main() {
  await loadEnvFile();
  const options = parseArgs(process.argv.slice(2));
  if (options.help || (!options.assetFolder && !options.screenshotFolder)) {
    console.log(usage());
    process.exit(options.help ? 0 : 1);
  }

  const assetFolderStat = options.assetFolder
    ? await stat(options.assetFolder).catch(() => null)
    : null;
  if (options.assetFolder && !assetFolderStat?.isDirectory()) {
    throw new Error(`Asset folder not found: ${options.assetFolder}`);
  }

  const screenshotFolderStat = options.screenshotFolder
    ? await stat(options.screenshotFolder).catch(() => null)
    : null;
  if (options.screenshotFolder && !screenshotFolderStat?.isDirectory()) {
    throw new Error(`Screenshot folder not found: ${options.screenshotFolder}`);
  }

  const assetImages = options.assetFolder ? await findImages(options.assetFolder) : [];
  const screenshotImages = options.screenshotFolder ? await findImages(options.screenshotFolder) : [];
  if (!options.sourceFile && options.assetFolder) {
    const htmlFiles = await findFilesByExtension(options.assetFolder, new Set([".html", ".htm"]));
    options.sourceFile = htmlFiles[0] || null;
  }

  if (assetImages.length === 0 && screenshotImages.length === 0) {
    throw new Error("No images found. Add screenshots to ./screenshot or extracted website assets to ./extracted.");
  }

  if (options.sourceFile) {
    const sourceStat = await stat(options.sourceFile).catch(() => null);
    if (!sourceStat?.isFile()) {
      throw new Error(`Source file not found: ${options.sourceFile}`);
    }
  }

  await mkdir(options.outDir, { recursive: true });
  const assetManifest = options.assetFolder
    ? await prepareContentAssets(assetImages, options.assetFolder, options.outDir)
    : [];
  const screenshotManifest = options.screenshotFolder
    ? await prepareScreenshotReferences(screenshotImages, options.screenshotFolder)
    : [];
  const manifest = [...assetManifest, ...screenshotManifest];
  const screenshotReferences = await buildReferenceImages(screenshotManifest, {
    maxReferenceImages: options.screenshotRefs
  });
  const assetReferences = buildContentImageReferences(assetManifest, options.assetPreviewCount);
  const referenceImages = [...screenshotReferences, ...assetReferences];
  const sourceBrief = await buildSourceBrief(options.sourceFile, manifest, options.sourceBriefChars);

  console.log(`Found ${screenshotManifest.length} screenshot reference${screenshotManifest.length === 1 ? "" : "s"} and ${assetManifest.length} extracted asset${assetManifest.length === 1 ? "" : "s"}.`);
  if (options.sourceFile) {
    console.log(`Using cleaned page source from ${options.sourceFile} (${sourceBrief.length} chars, cap ${options.sourceBriefChars}).`);
  }
  if (screenshotReferences.length > screenshotManifest.length) {
    console.log(`Added ${screenshotReferences.length - screenshotManifest.length} screenshot slice${screenshotReferences.length - screenshotManifest.length === 1 ? "" : "s"} for better visual analysis.`);
  }
  if (assetReferences.length > 0) {
    console.log(`Sending ${assetReferences.length} extracted asset preview${assetReferences.length === 1 ? "" : "s"} to the model; all ${assetManifest.length} copied assets are available in the manifest.`);
  } else if (assetManifest.length > 0) {
    console.log(`Sending extracted asset names, dimensions, and paths only; all ${assetManifest.length} copied assets are available in the manifest.`);
  }
  let generated;
  if (options.fromRaw) {
    console.log(`Reprocessing raw model response from ${options.fromRaw}...`);
    generated = postProcessGeneratedSite(extractGeneratedFiles(await readFile(options.fromRaw, "utf8")));
    validateGeneratedSite(generated, manifest);
  } else {
    console.log(`Generating with gemini (${options.model})...`);
    generated = await generateWithFallback({ ...options, manifest, referenceImages, sourceBrief });
  }
  await saveGeneratedSite(options.outDir, generated, manifest);
  console.log(`Generated site saved to ${options.outDir}`);

  if (!options.serve) {
    return;
  }

  const server = makeStaticServer(options.outDir);
  const port = await listen(server, options.port);
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Website: ${url}`);
  console.log("Keep this process running while the website is open. Press Ctrl+C to stop.");

  if (options.open) {
    openBrowser(url);
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
