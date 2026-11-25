import argparse
import os
from typing import Callable, List, Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


def _ignored_labels() -> set:
    raw = os.environ.get("PII_IGNORE_LABELS", "")
    return {l.strip() for l in raw.split(",") if l.strip()}


class _State:
    ready: bool = False
    classifier: Optional[Callable[[str], List[dict]]] = None

state = _State()

app = FastAPI()


def _ensure_loaded() -> None:
    if not state.ready:
        _load_model()


@app.on_event("startup")
def _startup() -> None:
    _load_model()


def _load_model() -> None:
    if os.environ.get("PII_SKIP_MODEL") == "1":
        state.classifier = lambda text: []
        state.ready = True
        return

    model_id = os.environ.get("PII_MODEL_ID", "openai/privacy-filter")
    from transformers import pipeline  # noqa: PLC0415
    state.classifier = pipeline(
        "token-classification",
        model=model_id,
        aggregation_strategy="simple",
    )
    state.ready = True


class TextBatch(BaseModel):
    texts: List[str]


class SpanInfo(BaseModel):
    start: int
    end: int
    label: str
    original: str


class RedactResult(BaseModel):
    redacted: str
    changed: bool
    spans: List[SpanInfo]


class BatchResponse(BaseModel):
    results: List[RedactResult]


@app.get("/health")
def health() -> dict:
    _ensure_loaded()
    if not state.ready:
        raise HTTPException(status_code=503, detail="Model loading")
    return {"status": "ok"}


@app.post("/redact_batch")
def redact_batch(body: TextBatch) -> BatchResponse:
    _ensure_loaded()
    if not state.ready:
        raise HTTPException(status_code=503, detail="Model loading")
    return BatchResponse(results=[_redact_one(t) for t in body.texts])


def _merge_adjacent(entities: List[dict], text: str) -> List[dict]:
    """Merge consecutive same-label spans separated only by whitespace."""
    if len(entities) <= 1:
        return entities
    by_start = sorted(entities, key=lambda e: e["start"])
    merged = [dict(by_start[0])]
    for ent in by_start[1:]:
        prev = merged[-1]
        prev_label = prev.get("entity_group", prev.get("entity"))
        cur_label = ent.get("entity_group", ent.get("entity"))
        between = text[prev["end"]:ent["start"]]
        if prev_label == cur_label and between.strip() == "":
            merged[-1]["end"] = ent["end"]
        else:
            merged.append(dict(ent))
    return merged


def _redact_one(text: str) -> RedactResult:
    assert state.classifier is not None
    entities: List[dict] = state.classifier(text)
    ignored = _ignored_labels()
    if ignored:
        entities = [
            e for e in entities
            if e.get("entity_group", e.get("entity")) not in ignored
        ]
    entities = _merge_adjacent(entities, text)
    sorted_ents = sorted(entities, key=lambda e: e["start"], reverse=True)
    spans: List[SpanInfo] = []
    redacted = text
    for ent in sorted_ents:
        start, end = ent["start"], ent["end"]
        label = ent.get("entity_group", ent.get("entity", "unknown"))
        # Skip leading whitespace so surrounding spaces are preserved
        while start < end and text[start].isspace():
            start += 1
        original = text[start:end]
        redacted = redacted[:start] + f"[{label}]" + redacted[end:]
        spans.append(SpanInfo(start=start, end=end, label=label, original=original))
    spans.reverse()
    return RedactResult(redacted=redacted, changed=bool(spans), spans=spans)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
