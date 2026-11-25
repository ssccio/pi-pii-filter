# pi-pii-filter

A [Pi Agent](https://github.com/badlogic/pi-mono) extension that redacts personally identifiable information (PII) from all text sent to the LLM provider, using a locally-running instance of OpenAI's [`openai/privacy-filter`](https://huggingface.co/openai/privacy-filter) model. No data leaves your machine.

## How it works

```
user input / tool result / compaction
         ↓
   context event (index.ts)
         ↓  [if enabled and server ready]
   POST /redact_batch → server.py → privacy-filter model
         ↓
   redacted text replaces original in message stream
         ↓
   provider receives only redacted content
```

A FastAPI sidecar (`server.py`) loads the model once on startup and stays resident. The extension intercepts all LLM-bound content via Pi's `context` event — user messages, tool results, compaction summaries, everything — and replaces detected PII with typed placeholders before the provider ever sees it.

**Detected categories:** `[private_person]`, `[private_email]`, `[private_phone]`, `[private_address]`, `[private_url]`, `[private_date]`, `[account_number]`, `[secret]`

## Prerequisites

- [Pi Agent](https://github.com/badlogic/pi-mono) installed
- Python 3.10+ with a virtual environment containing:
  - `fastapi`, `uvicorn`, `transformers`, `torch`
- Node.js (for running tests)

## Installation

Clone this repo into your Pi project's extensions directory:

```bash
cd your-pi-project
mkdir -p .pi/extensions
git clone https://github.com/ssccio/pi-pii-filter .pi/extensions/pii-filter
```

Pi auto-discovers extensions in `.pi/extensions/*/index.ts` on startup.

### Python dependencies

The extension expects a `.venv` at your project root. Install the required packages:

```bash
python -m venv .venv
.venv/bin/pip install fastapi uvicorn transformers torch
# or with uv:
uv venv && uv pip install fastapi uvicorn transformers torch
```

### First run

The `openai/privacy-filter` model (~3 GB) downloads to your HuggingFace cache on first use. Subsequent starts load from cache in seconds. The footer shows `⏳ PII loading...` during startup and `🔒 PII` once ready.

To prevent any HuggingFace network calls after the initial download:

```bash
export HF_HUB_OFFLINE=1
```

## Usage

| Command | Effect |
|---------|--------|
| `/pii on` | Enable filtering |
| `/pii off` | Disable filtering, stop server |
| `/pii log on` | Show before/after diff as a notification on each redacted turn |
| `/pii log off` | Disable logging |
| `/pii status` | Show current state (enabled, logging, server status, model) |

**Keyboard shortcut:** `option+shift+p` cycles through `off → on → on+log → off`.

## Config

`.pi/pii-filter.json` (created automatically, opt-in defaults):

```json
{
  "enabled": false,
  "logging": false,
  "modelId": "openai/privacy-filter"
}
```

`modelId` can be changed to any HuggingFace token-classification model.

`ignoreLabels` (optional, default `[]`) lists categories that are *not* redacted, e.g. `["private_url", "private_date"]`. Because the file lives in `.pi/`, this is configured per project. The server is started with `PII_IGNORE_LABELS` (comma-separated), so changes take effect on the next session or `/pii on`.

## Footer states

| Footer | Meaning |
|--------|---------|
| `🔒 PII` | Filtering active |
| `🔒 PII+log` | Filtering active with logging |
| `⏳ PII loading...` | Server starting / model loading |
| `⚠ PII` | Server error — run `/pii on` to retry |
| *(empty)* | Filtering off |

## Development

```bash
npm install
npm test          # TypeScript unit tests (vitest)

cd tests
pytest test_server.py -v   # Python server tests (requires .venv)
```

Tests use a `PII_SKIP_MODEL=1` stub so the real model is never loaded during CI.

## License

MIT
