# Scaler Clone Agent CLI

Conversational terminal agent for Assignment 02. The agent accepts natural language in the CLI, reasons through a multi-step loop, calls tools, and produces a working Scaler Academy-style webpage with HTML, CSS, and JavaScript.

## Quick Start

```bash
npm start
```

Then type:

```text
clone scaler academy
```

You can also ask it to collect a new website before generation:

```text
clone https://www.scaler.com
```

The agent prints `START`, `THINK`, `TOOL`, `OBSERVE`, and `OUTPUT` steps while it prepares reference data, generates files, validates the result, and starts the generated site locally when the environment allows it.

Generated files are written to:

```text
generated-site/
  index.html
  styles.css
  script.js
```

If the auto-start step is blocked by the environment, run:

```bash
npm run serve
```

## Demo-Friendly Mode

By default, the agent uses the built-in Scaler fixture and a saved model response:

```text
fixtures/scaler/
  screenshot/
  extracted/
  last-model-response.txt
```

This makes the assignment demo reliable and avoids burning API quota while showing the required agent loop and file generation.

The Scaler fixture was collected with Playwright from `https://www.scaler.com`. It contains a rendered full-page screenshot, rendered source HTML, downloaded image assets, and an asset manifest.

To force a fresh model call, include the word `fresh` in the prompt:

```text
clone scaler academy fresh
```

or run:

```bash
npm start -- --fresh
```

## Environment

For fresh generation, put keys in `.env`:

```text
GEMINI_API_KEY=your-gemini-key-here
```

Optional model override:

```text
AI_MODEL=gemini-2.5-flash
```

## Scripts

```text
npm start          Run the conversational assignment agent
npm run generate   Run the lower-level screenshot/source/assets generator directly
npm run collect    Collect screenshot/source/images from a URL with Playwright
npm run serve      Serve generated-site locally
```

Collector example:

```bash
npm run collect -- https://www.scaler.com --out ./runs/scaler
```

The collector writes:

```text
runs/scaler/
  screenshot/desktop-full.png
  extracted/source.html
  extracted/images/
  extracted/asset-manifest.json
```

Direct generator example:

```bash
npm run generate -- \
  --screenshots ./fixtures/scaler/screenshot \
  --assets ./fixtures/scaler/extracted \
  --source ./fixtures/scaler/extracted/source.html \
  --out ./generated-site
```

## What The Agent Does

The assignment loop is implemented in `bin/agent-cli.js`.

Available tools:

```text
prepareScalerContext   Checks fixture screenshot/source/assets
collectWebsite         Uses Playwright to collect screenshot/source/images for a URL
generateScalerClone    Calls the generator and writes HTML/CSS/JS
validateGeneratedSite  Confirms the expected output files exist
```

The lower-level generation engine is in `bin/image-site.js`. It accepts screenshot references, extracted assets, and saved page source, then asks a vision-capable model to produce `index.html`, `styles.css`, and `script.js`.

## Notes

- The screenshot is used only as a visual reference.
- Extracted assets are copied into `generated-site/assets`.
- The saved source is cleaned into a compact brief before being sent to the model.
- External URLs are scrubbed so the output remains self-contained.
- The generator is Gemini-only and defaults to `gemini-2.5-flash`.
- Fallback models are off by default to avoid wasting quota. Use `--allow-fallbacks` only if you intentionally want retries through the lighter Gemini models.
