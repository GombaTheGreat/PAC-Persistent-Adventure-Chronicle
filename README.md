# PAC — Persistent Adventure Chronicle

<p align="center">
  <img src="https://i.ibb.co/jkKXWPGR/Gomba-PAC.png" alt="PAC Logo" width="180" />
</p>

> A SillyTavern extension that gives your AI characters real, lasting memory across every chat session.

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://github.com/GombaTheGreat/pac/releases)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![SillyTavern](https://img.shields.io/badge/SillyTavern-extension-7c5cbf.svg)](https://sillytavern.app)

---

## The Problem

SillyTavern forgets everything between chats. Every time you open a new session, the character you've been building a story with starts from scratch — they don't know who you are, what titles you've earned, what happened to the world the last time you played, or the specific moments you shared together. You end up re-explaining yourself every time, or writing elaborate system prompts to paper over the gap.

PAC fixes that.

---

## What PAC Does

PAC automatically extracts the important things from your conversations and quietly injects all of it back into every future session. Your characters remember your titles, your history with them, what happened to the world, and the specific moments that mattered.

The memory is organised into layered stores, each injected into every future prompt:

| Layer | What it stores | Example |
|-------|----------------|---------|
| **Your Active Persona** | Permanent facts about your player character — titles earned, faction standings, reputation, NPC relationships | *"Champion of the Iron Circle, allied with the Merchant's Guild"* |
| **World State** | World-shaping events that permanently changed the setting | *"The old king was slain. The city of Vareth lies under rebel control."* |
| **Character Knowledge** | Permanent facts about the AI character you're talking to | *"Now known as the Exile Knight. Former member of the Silver Order."* |
| **Story So Far** | Compressed session summaries — the "previously on…" your AI reads before every chat | *A paragraph recap of what happened last time* |
| **Episodic Memories** | Specific moments — retrieved by relevance, not just recency | *"Rescued the merchant's daughter from the ruins"* |

Everything runs automatically. Just play. PAC builds up your story behind the scenes.

---

## Key Features

- **Auto-extraction** — after every 5 AI responses, PAC asks your AI to classify what happened and propose new memory entries
- **Approval dialogs** — before anything gets saved, you see exactly what was found and can tick/untick items
- **Session summaries** — every 30 messages, a compressed recap is generated and stored automatically
- **Hybrid memory search** — BM25 keyword search + optional semantic vector embeddings, merged with Reciprocal Rank Fusion
- **Persistent World mode** — share world/character memory across multiple personas; each persona's personal profile stays private
- **Memory consolidation** — intelligently merge groups of related memories to prevent log bloat over long campaigns
- **Token budget control** — configurable context budget with per-layer minimums so PAC never crowds out your conversation
- **Import / export** — back up and restore all memory data as a zip, per persona
- **Preview tab** — see exactly what text will be injected into the next prompt before you send anything
- **World tag scoping** — extension is completely inactive unless a character has a matching world tag; no accidental memory for random characters

---

## Requirements

- **SillyTavern** (latest release recommended)
- **The PAC server plugin** (included in this repo — must be installed manually, see below)
- An AI connection configured in SillyTavern (any provider — OpenAI, Claude, local models, etc.)

---

## Installation

PAC has **two parts**: the client extension (UI and logic) and a server plugin (storage and keyword search). Both must be installed.

### Method A — GitHub "Install Extension" + manual plugin

SillyTavern's built-in extension installer can install the client extension directly from this repo:

**Step 1 — Install the client extension**

1. In SillyTavern, open **Extensions** → click **Install Extension**
2. Paste the URL: `https://github.com/GombaTheGreat/pac`
3. Click Install and wait for it to complete

> **Note:** This only installs the client extension. The server plugin always requires manual installation.

**Step 2 — Install the server plugin manually**

Copy the `server-plugin/` folder from this repo into your SillyTavern `plugins/` directory:

```
SillyTavern/
└── plugins/
    └── pac/
        └── index.mjs    ← this file
```

**Step 3 — Enable server plugins**

Open `config.yaml` in your SillyTavern root folder and confirm this line exists (add it if not):

```yaml
enableServerPlugins: true
```

**Step 4 — Restart SillyTavern** fully — close and reopen, don't just refresh the browser.

**Step 5 — Enable PAC in SillyTavern**

Go to **Extensions** (the puzzle piece icon) and make sure **Persistent Adventure Chronicle** is enabled. A PAC panel will appear in your Extensions sidebar.

---

### Method B — Manual zip install

1. Download the latest release zip from the [Releases](https://github.com/GombaTheGreat/pac/releases) page
2. Extract into your **SillyTavern root folder** (the folder with `Start.bat` or `start.sh`). When prompted to merge folders, say **Yes**

You should end up with:
```
SillyTavern/
├── data/default-user/extensions/pac/   ← the client extension
└── plugins/pac/                         ← the server plugin
```

3. Add `enableServerPlugins: true` to `config.yaml`
4. Restart SillyTavern fully
5. Enable **Persistent Adventure Chronicle** in Extensions

> **Non-default username?** If your SillyTavern username isn't `default-user`, also copy the `extensions/pac/` folder from `data/default-user/` into `data/YOUR-USERNAME/extensions/`.

---

## First-Time Setup — World Tags

**This is the most important step.** PAC only activates for characters that belong to a recognised world — this scoping prevents it from accidentally building memory for every character you open.

**Three steps:**

1. **In PAC → General tab**, scroll to **World Tags** and add a name for your campaign world (e.g. `Eldoria`)
2. **Open the character** you want to track in SillyTavern's character editor and add the same word as a tag
3. **Open a chat** with that character — the PAC status bar will show the world name and begin tracking

The status bar looks like this when active:
```
🌍 Eldoria  |  Mira  |  2 memories · 1 summary
```

If it says **"No world tag detected"**, the character card doesn't have a matching tag yet.

> **Tip:** Give multiple characters the same world tag to share memory across all of them — the world state and character histories link up automatically.

---

## How It Works

```
[Every 5 AI messages]
  Recent conversation
          ↓
    Your AI model     ← classifies what happened
          ↓
  Approval dialog     ← you tick/untick what gets saved
          ↓
  Stored as JSON/JSONL + vector index updated

[At every generation]
  Load from storage:
    ├── Your persona facts
    ├── World state facts
    ├── Character knowledge
    ├── Recent session summaries
    └── Relevant episodic memories  (BM25 + semantic search)
          ↓
  Inject into prompt context (within token budget)
          ↓
  AI responds knowing your shared history
```

All memory is stored as plain JSON/JSONL files in your SillyTavern user data folder — human-readable, easy to back up, and editable in any text editor. Nothing is sent anywhere outside your machine.

---

## Repository Structure

For contributors and anyone building release zips — this is how the repository is laid out for GitHub compatibility:

```
/ (repo root)
├── manifest.json        ← ST extension manifest (must be at root for Install Extension)
├── index.js             ← Main extension logic
├── settings.html        ← Extension UI template
├── style.css            ← Styles
├── src/                 ← Core client modules
│   ├── api.js               REST client to server plugin
│   ├── extractor.js         AI fact extraction & classification
│   ├── event-log.js         Episodic memory storage
│   ├── identity-store.js    Persona/world/character fact persistence
│   ├── injector.js          Prompt assembly & injection
│   ├── summary.js           Session summary generation
│   └── vector-store.js      Semantic search client
├── server-plugin/       ← Server plugin (manual installation required)
│   └── index.mjs            BM25 search, REST API routes, file I/O
├── README.md            ← This file
└── index.html           ← Project showcase page
```

> `manifest.json` must be at the repository root for SillyTavern's "Install Extension" to work — it's what ST reads to discover the extension. The server plugin lives in a subfolder because it needs to be manually copied into `SillyTavern/plugins/pac/`.

---

## Why We Made This

SillyTavern is brilliant for roleplay and collaborative storytelling with AI. But the amnesia between sessions breaks immersion in a way that's hard to paper over. You can write long system prompts that describe who you are — but they're static, they don't grow with your story, and maintaining them by hand becomes a real chore the longer a campaign runs.

PAC is what we wanted to exist: something that quietly watches your story unfold, pulls out what matters, and makes sure your characters actually know you the next time you talk to them. The AI you've been building a campaign with should know you're the Champion of the Iron Circle before you have to tell it again.

It's made for people who want their AI adventures to feel like they're going somewhere — where the characters you care about remember the journey.

---

## License

```
MIT License

Copyright (c) 2026 GombaTheGreat

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Disclaimer

PAC is an unofficial third-party extension and is not affiliated with, endorsed by, or supported by the SillyTavern project. It is provided as-is with no guarantee of compatibility with future SillyTavern versions.

Memory extraction and classification is performed by whichever AI model you have configured in SillyTavern — the quality and accuracy of extracted memories depends entirely on that model's capabilities. PAC does not transmit your data anywhere; all memory is stored locally on your machine.

Use at your own risk. Back up your data regularly using the Persona Management export feature.

---

*PAC v0.1.0 — by [GombaTheGreat](https://github.com/GombaTheGreat)*
