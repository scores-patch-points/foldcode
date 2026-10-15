---
name: fold-perceive
description: Give any opencode model the local senses (pixels, audio) and the fold's discipline — download, run, convert every output to EOT, and build the activation layer. Use when a task needs to read an image, transcribe audio, or ground meaning in a workspace. The pixels are read locally and mechanically; no model, local or frontier, ever sees a pixel.
---

# fold-perceive — the local senses, and the wall

Two senses live on this box. Neither is a model. A frontier or local model may
**call** them and read their **text**; a model never reads a pixel and never
writes down what a sense did not measure.

- **Vision — image-khora.** The OCR / pixel pipeline (Tesseract + atlases +
  provenance; no vision model, no network). It answers the doorway's `perceive`
  contract: a page's pixels become a **measured card** — typed fields, each with
  its region and its source — never a sentence. `Alhazen` is the pure-JS optics
  pipeline (keys, value formats, grid structure) when there is no OCR install.
  A **local CV model** may also be the vision sense when a task needs one (the
  same pattern used in the fold's own apps): it runs on this box and opencode
  **chats with it** — the doorway forwards the image to the local CV model and
  returns its text. The frontier LLM never needs vision; it only ever reads the
  text a sense produced.
- **Audio — whisper.** `holodeck/tools/asr-server.py` runs MLX Whisper locally on
  `http://127.0.0.1:11460`. It returns a transcript with word timestamps. No
  network; the audio never leaves the machine.

The local text models (Ollama on **11435**, not 11434: `gemma2:2b`,
`qwen2.5-coder:1.5b`, `nomic-embed-text`) are **text-only**. They read what a
sense extracted, never the pixel or the waveform. Anything they add beyond the
literal fields — a date, a cause, a "why" — is **confabulation**, and it is the
class the reason-gate refuses.

## Install and run

### World dependencies (once)

```sh
brew install tesseract          # image-khora's OCR (vision)
command -v node >/dev/null      # Alhazen needs only node (pure JS)
```

### Whisper (the audio sense)

```sh
# from the holodeck checkout
python3 -m venv .whisper-venv
.whisper-venv/bin/pip install -U mlx-whisper   # Apple silicon; else faster-whisper
.whisper-venv/bin/python tools/asr-server.py --port 11460
curl -s http://127.0.0.1:11460/health          # { ok, engine, model, device }
```

`POST /transcribe?language=en&task=transcribe` with the audio bytes as the body.
`language=auto` when unknown; `task=translate` to render non-English speech in
English. The server is stateless and local.

### Vision (the pixel sense)

- **With OCR:** call image-khora's `perceive` (the doorway contract). Feed it an
  image; get back a card of measured fields with regions and provenance.
- **Without OCR:** `import { read } from "<Alhazen>/alhazen.js"` and run the pure
  optics pipeline on the image's text layer.

## Convert everything to EOT

Every perception, whatever produced it, becomes **one EOT observation row** before
anything reasons over it. The shape is the fold's:

```json
{ "schema": "EOTObservation@1", "id": "$perceive-…", "role": "part",
  "title": "<the ask>", "text": "<the bytes the sense returned>",
  "giver": "image-khora <source> or whisper <model>", "supersedes": [] }
```

Rules, and they are the whole discipline:

- **The bytes are the bytes.** A transcript is the words the waveform carried; a
  card is the fields the pixels carry. Never paraphrase a sense's output, never
  "clean it up" from memory.
- **Provenance is the `giver`.** Name the sense and the source (file, page,
  region, byte range, model tag). A row without a giver is not an observation.
- **Absence is a result.** A word the waveform does not carry, a field the page
  does not show — say so (`No ground`), never fill it in.
- **A model's additions are separate rows,** with the model as giver, and marked
  as inference. They never wear a sense's giver.

## The activation layer (inferred contextual meaning)

Above the literal rows, build an **activation** pass over the workspace: for each
ask, find the passages whose **own words** it points at — mechanically, by
address, the fold's rule — and record which rows activated, with their address.
Activation is a *layer of inferred meaning*, disclosed as inference:

- It decides by **measured overlap** (shared terms at real addresses), never by a
  vector, never by a model's guess. An embedding may nominate; it never decides.
- Every activation names its basis (`giver: eodb:activation`) and the rows it
  drew from, so the layer is auditable — and falsifiable.

## Default: go local, and obtain what is missing

opencode X-fold defaults to local. When a task needs a modality the harness does
not have, **obtain it locally** rather than refusing or reaching for a hosted
service — and do it the same way every time:

- **A local model by default.** Ollama on `11435`: pull `gemma2:2b` (fast text),
  `qwen2.5-coder:1.5b` (tools), `nomic-embed-text` (embeddings). Pull only what
  the task needs.
  ```sh
  OLLAMA_HOST=127.0.0.1:11435 ollama pull gemma2:2b
  ```
- **A local CV model when vision needs one** (the pattern the fold's apps use):
  opencode chats with it; the frontier never does.
- **Whisper** for audio, **tesseract** for images — the senses above.
- **Any ingestion the harness lacks:** images (`perceive`), audio (`transcribe`),
  pages (`webfetch`), whole folders/a repo (the door's `/v1/workspace` +
  `/v1/documents`), and video via the local yt-dlp helper. If a source type has
  no path yet, add the smallest local one and name it — never invent a reading.

The order is fixed: **local before remote, mechanical before generated, free
before paid.** A hosted model is the last resort, and only when the task truly
needs it.

## Use the fold's power: meaning from anything, signal from noise

The fold reads. Point it at anything — a page, a screenshot, a recording, a repo,
a statute — and:

1. **Reduce every input to bytes at an address.** A perception becomes an
   `EOTObservation@1` row; its provenance is its address (file, page, region,
   byte range, model tag). Nothing enters without an address.
2. **Extract signal from noise mechanically.** Keep the passages the ask's own
   words point at — by measured overlap at real addresses, never by a vector,
   never by a guess. Receipt every elision with its range; what is not needed is
   not carried, and what was dropped stays readable.
3. **Prefer mechanical output.** Compute, count, snip, and cut verbatim before
   generating. If a fact, a total, a quote, or a range can be produced by rule,
   it is — and it is stamped, so it cannot be confused with prose. Generate only
   what genuinely cannot be measured.
4. **Build the activation layer as inference, on the record.** Over the rows,
   record which activated which, with the basis named (`eodb:activation`) — a
   layer of inferred contextual meaning that is auditable and falsifiable.
5. **Disclose the gaps.** Absence is a result: a field the image does not show, a
   word the waveform does not carry, a question the corpus is silent on. Say it;
   never fill it.

The measure of success is a reading you can check: every claim descends to an
address, every elision is receipted, and everything mechanical is mechanical.

## The wall (say it plainly)

- A **sense** measures; a **model** phrases. Keep them in different rows with
  different givers.
- The local text models are **text-only**; feeding one an image is a category
  error — feed it image-khora's card text instead.
- A conclusion a model states that no row grounds is **not a reading**. Refuse
  it, or record it as inference with the model's name on it.
