#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { access, readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const cwd = process.cwd();
const scalerFixture = {
  screenshotDir: path.join(cwd, "fixtures", "scaler", "screenshot"),
  assetDir: path.join(cwd, "fixtures", "scaler", "extracted"),
  sourceFile: path.join(cwd, "fixtures", "scaler", "extracted", "source.html"),
  rawResponse: path.join(cwd, "fixtures", "scaler", "last-model-response.txt")
};

function logStep(step, content, extra = {}) {
  console.log(JSON.stringify({ step, content, ...extra }, null, 2));
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function countFiles(folder) {
  const entries = await readdir(folder, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const fullPath = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      count += await countFiles(fullPath);
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}

async function prepareScalerContext() {
  const requiredPaths = [
    scalerFixture.screenshotDir,
    scalerFixture.assetDir,
    scalerFixture.sourceFile
  ];

  for (const item of requiredPaths) {
    if (!await pathExists(item)) {
      throw new Error(`Missing Scaler fixture path: ${item}`);
    }
  }

  return {
    screenshotDir: scalerFixture.screenshotDir,
    assetDir: scalerFixture.assetDir,
    sourceFile: scalerFixture.sourceFile,
    screenshots: await countFiles(scalerFixture.screenshotDir),
    assets: await countFiles(scalerFixture.assetDir),
    hasSavedModelResponse: await pathExists(scalerFixture.rawResponse)
  };
}

function sanitizeFileName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "website";
}

async function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with exit code ${code}: ${command} ${args.join(" ")}\n${stderr || stdout}`));
      }
    });
  });
}

async function collectWebsite(url) {
  const parsed = new URL(url);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(cwd, "runs", `${sanitizeFileName(parsed.hostname)}-${stamp}`);
  await runCommand(process.execPath, [
    "bin/collect-website.js",
    parsed.toString(),
    "--out",
    outDir
  ]);

  return {
    outDir,
    screenshotDir: path.join(outDir, "screenshot"),
    assetDir: path.join(outDir, "extracted"),
    sourceFile: path.join(outDir, "extracted", "source.html")
  };
}

async function generateCloneFromContext({
  screenshotDir,
  assetDir,
  sourceFile,
  rawResponse = null,
  fresh = true,
  allowFallbacks = fresh
}) {
  const args = [
    "bin/image-site.js",
    "--screenshots",
    screenshotDir,
    "--assets",
    assetDir,
    "--source",
    sourceFile,
    "--out",
    path.join(cwd, "generated-site"),
    "--no-serve"
  ];

  const useRaw = !fresh && rawResponse && await pathExists(rawResponse);
  if (useRaw) {
    args.push("--from-raw", rawResponse);
  }
  if (!useRaw && allowFallbacks) {
    args.push("--allow-fallbacks");
  }

  await runCommand(process.execPath, args);
  return {
    outDir: path.join(cwd, "generated-site"),
    mode: useRaw
      ? "saved model response fixture"
      : allowFallbacks
        ? "fresh model generation with Gemini fallbacks"
        : "fresh model generation"
  };
}

async function generateScalerClone({ fresh = false } = {}) {
  return generateCloneFromContext({
    screenshotDir: scalerFixture.screenshotDir,
    assetDir: scalerFixture.assetDir,
    sourceFile: scalerFixture.sourceFile,
    rawResponse: scalerFixture.rawResponse,
    fresh
  });
}

async function validateGeneratedSite() {
  const outDir = path.join(cwd, "generated-site");
  const files = ["index.html", "styles.css", "script.js"];
  const result = {};

  for (const file of files) {
    const filePath = path.join(outDir, file);
    const fileStat = await stat(filePath);
    result[file] = `${fileStat.size} bytes`;
  }

  return {
    outDir,
    files: result,
    open: path.join(outDir, "index.html")
  };
}

async function startGeneratedSiteServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/serve-site.js", "generated-site"], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let outputBuffer = "";
    let errorBuffer = "";
    const timeout = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      reject(new Error("Timed out while starting the local website server."));
    }, 8000);

    const finish = (url) => {
      clearTimeout(timeout);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve({ url, pid: child.pid });
    };

    child.stdout.on("data", (chunk) => {
      outputBuffer += chunk.toString();
      const match = outputBuffer.match(/Website:\s*(http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) finish(match[1]);
    });

    child.stderr.on("data", (chunk) => {
      errorBuffer += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      if (!outputBuffer.includes("Website:")) {
        clearTimeout(timeout);
        reject(new Error(`Website server exited with code ${code}. ${errorBuffer || outputBuffer}`));
      }
    });
  });
}

function formatServerStartError(error) {
  const message = error?.message || String(error);
  const listenMatch = message.match(/listen\s+([A-Z]+):[^]*?(\d+\.\d+\.\d+\.\d+:\d+)/);
  if (listenMatch) {
    return `Local server start was blocked (${listenMatch[1]} on ${listenMatch[2]}).`;
  }
  return message.split("\n").find(Boolean) || "Unknown server start error.";
}

async function startSiteWhenReady(label) {
  logStep("THINK", "The files are ready, so I should start the generated website automatically.");
  logStep("TOOL", "Starting local website server.", { tool_name: "startGeneratedSiteServer", tool_args: "generated-site" });

  try {
    const server = await startGeneratedSiteServer();
    logStep("OBSERVE", `Website server is running at ${server.url} with pid ${server.pid}.`);
    logStep("OUTPUT", `${label} is ready and running at ${server.url}`);
  } catch (error) {
    logStep("OBSERVE", `Could not start the local server automatically: ${formatServerStartError(error)}`);
    logStep("OUTPUT", `${label} files are ready in generated-site. Run npm run serve to open it locally.`);
  }
}

function wantsScalerClone(message) {
  return /\b(scaler|academy|clone|website|site|webpage|landing)\b/i.test(message);
}

function extractUrl(message) {
  const match = String(message).match(/https?:\/\/[^\s]+/i);
  return match ? match[0].replace(/[),.;]+$/, "") : null;
}

function wantsFreshGeneration(message) {
  return /\b(fresh|api|regenerate|model|gemini|live)\b/i.test(message);
}

async function handleUserMessage(message) {
  if (!message.trim()) return;

  if (/\b(exit|quit|bye)\b/i.test(message)) {
    logStep("OUTPUT", "Goodbye. The agent loop is stopping.");
    return "exit";
  }

  const url = extractUrl(message);
  if (url) {
    logStep("START", `User wants to clone a new website: ${url}`);
    logStep("THINK", "I need to collect browser-rendered reference data before generation.");
    logStep("TOOL", "Collecting screenshot, rendered source, and image assets.", { tool_name: "collectWebsite", tool_args: url });
    const collected = await collectWebsite(url);
    const collectedAssets = await countFiles(collected.assetDir);
    const collectedScreenshots = await countFiles(collected.screenshotDir);
    logStep("OBSERVE", `Collected ${collectedScreenshots} screenshot file(s) and ${collectedAssets} extracted file(s) into ${collected.outDir}.`);

    logStep("THINK", "Now I can use the collected website data as generator context.");
    logStep("TOOL", "Generating clone from collected website context.", { tool_name: "generateCloneFromContext", tool_args: collected.outDir });
    const generated = await generateCloneFromContext({ ...collected, fresh: true });
    logStep("OBSERVE", `Generated files in ${generated.outDir} using ${generated.mode}.`);

    logStep("THINK", "I should validate that the expected browser files exist.");
    logStep("TOOL", "Validating generated output.", { tool_name: "validateGeneratedSite", tool_args: "generated-site" });
    const validation = await validateGeneratedSite();
    logStep("OBSERVE", `Validated index.html (${validation.files["index.html"]}), styles.css (${validation.files["styles.css"]}), and script.js (${validation.files["script.js"]}).`);

    await startSiteWhenReady("Website clone");
    return;
  }

  if (!wantsScalerClone(message)) {
    logStep("START", "The user sent a general message.");
    logStep("THINK", "I can clone the built-in Scaler fixture or collect a new website URL.");
    logStep("OUTPUT", "Ask me to clone Scaler, or provide a URL such as: clone https://www.scaler.com");
    return;
  }

  const fresh = wantsFreshGeneration(message) || process.argv.includes("--fresh");
  logStep("START", "User wants the Scaler Academy website cloned into working HTML, CSS, and JavaScript.");
  logStep("THINK", "I need reference data first: screenshot, extracted assets, and saved page source.");
  logStep("TOOL", "Preparing the built-in Scaler fixture.", { tool_name: "prepareScalerContext", tool_args: "scaler" });
  const context = await prepareScalerContext();
  logStep("OBSERVE", `Found ${context.screenshots} screenshot file(s), ${context.assets} extracted file(s), and source HTML. Saved model response: ${context.hasSavedModelResponse}.`);

  const canUseSavedResponse = context.hasSavedModelResponse && !fresh;
  logStep("THINK", canUseSavedResponse
    ? "A saved model response fixture is available, so I can reprocess it without spending API quota."
    : "No saved response is available for this fixture or the user requested fresh generation, so I will call Gemini.");
  logStep("TOOL", "Generating website files.", { tool_name: "generateScalerClone", tool_args: fresh ? "fresh=true" : "fresh=false" });
  const generated = await generateScalerClone({ fresh });
  logStep("OBSERVE", `Generated files in ${generated.outDir} using ${generated.mode}.`);

  logStep("THINK", "I should validate that the expected browser files exist.");
  logStep("TOOL", "Validating generated output.", { tool_name: "validateGeneratedSite", tool_args: "generated-site" });
  const validation = await validateGeneratedSite();
  logStep("OBSERVE", `Validated index.html (${validation.files["index.html"]}), styles.css (${validation.files["styles.css"]}), and script.js (${validation.files["script.js"]}).`);

  await startSiteWhenReady("Scaler clone");
}

async function main() {
  console.log("Scaler Clone Agent CLI");
  console.log("Type: clone scaler academy");
  console.log("Or type: clone https://example.com");
  console.log("Tip: add the word 'fresh' to call the model API instead of using the saved fixture.");
  console.log("Type 'exit' to quit.\n");

  const rl = createInterface({ input, output });
  try {
    while (true) {
      let answer;
      try {
        answer = await rl.question("You: ");
      } catch (error) {
        if (/readline was closed/i.test(error?.message || "")) break;
        throw error;
      }
      const result = await handleUserMessage(answer);
      if (result === "exit") break;
      console.log("");
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  logStep("OUTPUT", error?.message || String(error));
  process.exit(1);
});
