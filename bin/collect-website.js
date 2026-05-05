#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const cwd = process.cwd();
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".svg", ".ico"]);
const DEFAULT_CHROME = "/usr/bin/google-chrome";

function usage() {
  return `Usage:
  node bin/collect-website.js <url> [options]

Options:
  --out <folder>       Output folder (default: ./runs/<host>-<timestamp>)
  --chrome <path>      Chrome/Chromium executable path (default: /usr/bin/google-chrome)
  --width <number>     Viewport width (default: 1280)
  --height <number>    Viewport height (default: 900)
  --help               Show help`;
}

function parseArgs(argv) {
  const options = {
    url: null,
    outDir: null,
    chromePath: DEFAULT_CHROME,
    width: 1280,
    height: 900
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--out") {
      options.outDir = path.resolve(cwd, requiredValue(argv, ++index, "--out"));
    } else if (arg === "--chrome") {
      options.chromePath = requiredValue(argv, ++index, "--chrome");
    } else if (arg === "--width") {
      options.width = Number(requiredValue(argv, ++index, "--width"));
    } else if (arg === "--height") {
      options.height = Number(requiredValue(argv, ++index, "--height"));
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!options.url) {
      options.url = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.width) || options.width < 320) {
    throw new Error("--width must be an integer >= 320.");
  }
  if (!Number.isInteger(options.height) || options.height < 320) {
    throw new Error("--height must be an integer >= 320.");
  }

  return options;
}

function requiredValue(argv, index, optionName) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function sanitizeFileName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "asset";
}

function defaultOutDir(url) {
  const parsed = new URL(url);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(cwd, "runs", `${sanitizeFileName(parsed.hostname)}-${stamp}`);
}

function isLikelyImageUrl(value) {
  try {
    const parsed = new URL(value);
    const ext = path.extname(parsed.pathname).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

function extensionFromContentType(contentType) {
  if (/svg/i.test(contentType)) return ".svg";
  if (/png/i.test(contentType)) return ".png";
  if (/jpe?g/i.test(contentType)) return ".jpg";
  if (/webp/i.test(contentType)) return ".webp";
  if (/gif/i.test(contentType)) return ".gif";
  if (/avif/i.test(contentType)) return ".avif";
  if (/x-icon|icon/i.test(contentType)) return ".ico";
  return "";
}

function assetFileName(assetUrl, contentType, usedNames) {
  const parsed = new URL(assetUrl);
  const originalBase = path.basename(parsed.pathname).split("?")[0];
  const originalExt = path.extname(originalBase).toLowerCase();
  const ext = IMAGE_EXTENSIONS.has(originalExt) ? originalExt : extensionFromContentType(contentType) || ".bin";
  const stem = sanitizeFileName(originalBase.replace(/\.[^.]+$/, "") || parsed.hostname);
  let fileName = `${stem}${ext}`;
  let counter = 2;

  while (usedNames.has(fileName)) {
    fileName = `${stem}-${counter}${ext}`;
    counter += 1;
  }

  usedNames.add(fileName);
  return fileName;
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = Math.max(400, Math.floor(window.innerHeight * 0.75));
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.documentElement.scrollHeight - window.innerHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 250);
    });
  });
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    try {
      return await import("playwright-core");
    } catch {
      throw new Error("Playwright is not installed. Install it with: npm install -D playwright-core");
    }
  }
}

async function collectWebsite(options) {
  const { chromium } = await loadPlaywright();
  const url = new URL(options.url).toString();
  const outDir = options.outDir || defaultOutDir(url);
  const screenshotDir = path.join(outDir, "screenshot");
  const extractedDir = path.join(outDir, "extracted");
  const imagesDir = path.join(extractedDir, "images");
  await mkdir(screenshotDir, { recursive: true });
  await mkdir(imagesDir, { recursive: true });

  const imageResponses = new Map();
  const browser = await chromium.launch({
    headless: true,
    executablePath: options.chromePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-crash-reporter",
      "--disable-crashpad",
      "--disable-gpu",
      "--disable-dev-shm-usage"
    ]
  });
  const page = await browser.newPage({
    viewport: { width: options.width, height: options.height },
    deviceScaleFactor: 1
  });

  page.on("response", async (response) => {
    const responseUrl = response.url();
    const contentType = response.headers()["content-type"] || "";
    if (!contentType.startsWith("image/") && !isLikelyImageUrl(responseUrl)) return;
    imageResponses.set(responseUrl, { responseUrl, contentType, response });
  });

  await page.goto(url, { waitUntil: "networkidle", timeout: 90000 });
  await autoScroll(page);
  await page.waitForTimeout(1200);

  const domImageUrls = await page.evaluate(() => {
    const urls = new Set();
    const add = (value) => {
      if (!value) return;
      try {
        urls.add(new URL(value, window.location.href).toString());
      } catch {}
    };

    for (const img of document.querySelectorAll("img")) {
      add(img.currentSrc || img.src);
      for (const part of (img.srcset || "").split(",")) add(part.trim().split(/\s+/)[0]);
    }
    for (const source of document.querySelectorAll("source")) {
      add(source.src);
      for (const part of (source.srcset || "").split(",")) add(part.trim().split(/\s+/)[0]);
    }
    for (const link of document.querySelectorAll('link[rel~="icon"], link[rel="preload"][as="image"]')) {
      add(link.href);
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const style = getComputedStyle(walker.currentNode);
      for (const prop of ["backgroundImage", "borderImageSource", "listStyleImage"]) {
        const match = style[prop]?.match(/url\(["']?([^"')]+)["']?\)/);
        if (match) add(match[1]);
      }
    }

    return [...urls];
  });

  const sourceHtml = await page.content();
  await writeFile(path.join(extractedDir, "source.html"), sourceHtml, "utf8");
  await page.screenshot({ path: path.join(screenshotDir, "desktop-full.png"), fullPage: true });

  const usedNames = new Set();
  const manifest = [];
  const allImageUrls = new Set([...imageResponses.keys(), ...domImageUrls].filter(isLikelyImageUrl));

  for (const assetUrl of allImageUrls) {
    try {
      const existing = imageResponses.get(assetUrl);
      const response = existing?.response || await page.request.get(assetUrl);
      if (!response.ok()) continue;

      const contentType = existing?.contentType || response.headers()["content-type"] || "";
      if (!contentType.startsWith("image/") && !isLikelyImageUrl(assetUrl)) continue;

      const buffer = await response.body();
      const fileName = assetFileName(assetUrl, contentType, usedNames);
      await writeFile(path.join(imagesDir, fileName), buffer);
      manifest.push({
        url: assetUrl,
        file: `images/${fileName}`,
        contentType,
        bytes: buffer.length
      });
    } catch {
      // Skip assets that fail CORS, expire, or disappear during collection.
    }
  }

  await writeFile(path.join(extractedDir, "asset-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await browser.close();

  return {
    outDir,
    screenshotDir,
    extractedDir,
    sourceFile: path.join(extractedDir, "source.html"),
    imageCount: manifest.length
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.url) {
    console.log(usage());
    process.exit(options.help ? 0 : 1);
  }

  const result = await collectWebsite(options);
  console.log(`Saved screenshot to ${result.screenshotDir}`);
  console.log(`Saved rendered source to ${result.sourceFile}`);
  console.log(`Saved ${result.imageCount} image asset${result.imageCount === 1 ? "" : "s"} to ${path.join(result.extractedDir, "images")}`);
  console.log(`Output folder: ${result.outDir}`);
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
