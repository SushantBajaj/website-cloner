# Scaler Clone CLI Agent

A conversational CLI agent for the Scaler Academy clone assignment.

The project does two related jobs:

1. It gives you a terminal agent that accepts natural language commands like `clone scaler academy`.
2. It can collect website context and generate a self-contained static clone using `HTML`, `CSS`, and `JavaScript`.

The generated site is written to `generated-site/` and can be opened locally in a browser.

## What This Project Does

For the assignment, the main happy path is:

1. Start the agent in the terminal.
2. Ask it to clone Scaler Academy.
3. Let it reason in steps: `START`, `THINK`, `TOOL`, `OBSERVE`, `OUTPUT`.
4. Generate `index.html`, `styles.css`, and `script.js`.

The repo also supports a more general flow where the agent can collect a fresh website from a URL, extract images and page source, and then generate a clone from that context.

## Project Shape

```text
bin/
  agent-cli.js         Conversational assignment agent
  image-site.js        Gemini-powered site generator
  collect-website.js   Playwright collector for screenshot/source/assets
  serve-site.js        Local static file server

fixtures/scaler/
  screenshot/          Scaler reference screenshot(s)
  extracted/           Scaler source HTML + assets
  last-model-response.txt

generated-site/
  index.html
  styles.css
  script.js
  assets/
```

## Quick Start

Install dependencies:

```bash
npm install
```

Run the agent:

```bash
npm start
```

Then type one of these:

```text
clone scaler academy
clone scaler academy fresh
clone https://www.scaler.com
exit
```

## Recommended Demo Flow

If you want the smoothest assignment demo:

```text
clone scaler academy
```

That path uses the built-in Scaler fixture and the saved raw model response when available, which makes the demo fast and avoids live API quota drama.

If you want to prove the live model path too:

```text
clone scaler academy fresh
```

Fresh runs call Gemini and automatically allow fallback through lighter Gemini models when the primary model is busy.

## Scripts

```text
npm start          Start the conversational CLI agent
npm run generate   Run the generator directly
npm run collect    Collect screenshot/source/assets from a live URL
npm run serve      Serve generated-site locally
```

## Direct Commands

Collect a website with Playwright:

```bash
npm run collect -- https://www.scaler.com --out ./runs/scaler
```

Generate from existing screenshot/source/assets:

```bash
npm run generate -- \
  --screenshots ./fixtures/scaler/screenshot \
  --assets ./fixtures/scaler/extracted \
  --source ./fixtures/scaler/extracted/source.html \
  --out ./generated-site
```

Generate with fallback models enabled:

```bash
npm run generate -- \
  --screenshots ./fixtures/scaler/screenshot \
  --assets ./fixtures/scaler/extracted \
  --source ./fixtures/scaler/extracted/source.html \
  --out ./generated-site \
  --allow-fallbacks
```

Serve the generated site manually:

```bash
npm run serve
```

## Environment

Create a `.env` file with:

```text
GEMINI_API_KEY=your-gemini-api-key
```

Optional:

```text
AI_MODEL=gemini-flash-latest
```

Keep `.env` private. Do not commit real API keys.

## How The Agent Thinks

The assignment asks for an agent loop rather than a one-shot script, so `bin/agent-cli.js` prints structured reasoning steps:

```text
START
THINK
TOOL
OBSERVE
OUTPUT
```

That makes the terminal session easy to explain in a video demo and easy to debug when something goes wrong.

## How Generation Works

`bin/image-site.js` combines three inputs:

1. Screenshot references for layout, spacing, section order, and visual rhythm.
2. Extracted assets for real local images the generated site can reuse.
3. A cleaned brief from page source for copy, hierarchy, and interaction hints.

The generator then asks Gemini for exactly three files:

```text
index.html
styles.css
script.js
```

After generation, the output is checked to make sure it stays self-contained and does not pull in external URLs.

## Why The Scaler Fixture Exists

Live website cloning is useful, but it is noisy:

- quota can fail
- models can be rate-limited
- websites can change between runs
- assets can disappear or move

The Scaler fixture gives you a stable assignment path. It contains:

- a full-page screenshot
- cleaned source HTML
- extracted local assets
- a saved raw model response for reliable demo runs

## Troubleshooting

If `npm start` generates files but does not auto-open the site:

```bash
npm run serve
```

If Gemini says the model is under high demand:

- use `--allow-fallbacks`
- try again after a short wait
- use the default fixture path for demos

If Gemini returns `limit: 0` quota errors:

- the issue is usually project-level quota access, not the key string itself
- try a completely new Gemini project, not just a new key
- test a tiny Gemini prompt before using the full website generator

If the generated site looks generic:

- improve the fixture inputs
- collect a better full-page screenshot
- make sure extracted assets really came from the target website
- use fresh generation only when the Gemini project is healthy

## Notes For Submission

The assignment asks for:

1. A public GitHub repository.
2. A 2 to 3 minute demo video.
3. A working clone of the Scaler Academy website.
4. A visible agent loop in the terminal.

For the cleanest video:

- show `npm start`
- type `clone scaler academy`
- let the loop print its reasoning steps
- open the generated site
- briefly show the output files in `generated-site/`

## Core Files

- `bin/agent-cli.js`
- `bin/image-site.js`
- `bin/collect-website.js`
- `bin/serve-site.js`
