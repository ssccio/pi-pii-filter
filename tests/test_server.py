import os
os.environ["PII_SKIP_MODEL"] = "1"  # Must be set before importing server

import pytest
from fastapi.testclient import TestClient


def get_client():
    from server import app
    return TestClient(app)


def test_health_returns_ok():
    client = get_client()
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_redact_batch_empty_list():
    client = get_client()
    resp = client.post("/redact_batch", json={"texts": []})
    assert resp.status_code == 200
    assert resp.json()["results"] == []


def test_redact_batch_stub_returns_unchanged():
    client = get_client()
    resp = client.post("/redact_batch", json={"texts": ["Hello world", "No PII here"]})
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert len(results) == 2
    assert results[0]["redacted"] == "Hello world"
    assert results[0]["changed"] is False
    assert results[0]["spans"] == []
    assert results[1]["redacted"] == "No PII here"


def test_redact_batch_structure():
    client = get_client()
    resp = client.post("/redact_batch", json={"texts": ["test"]})
    result = resp.json()["results"][0]
    assert "redacted" in result
    assert "changed" in result
    assert "spans" in result
    assert isinstance(result["spans"], list)


def test_health_returns_503_when_not_ready():
    import server
    from unittest.mock import patch
    # Patch _load_model to be a no-op so startup doesn't set state.ready = True
    original = server.state.ready
    server.state.ready = False
    try:
        with patch.object(server, "_load_model", lambda: None):
            client = TestClient(server.app)
            resp = client.get("/health")
        assert resp.status_code == 503
    finally:
        server.state.ready = original


def test_adjacent_same_label_spans_are_merged():
    """Multi-word names split into separate tokens should merge into one placeholder."""
    import server

    def fake_classifier(_text):
        # Simulate "John" and "Smith" returned as separate private_person spans
        return [
            {"start": 11, "end": 15, "entity_group": "private_person"},  # John
            {"start": 16, "end": 21, "entity_group": "private_person"},  # Smith
        ]

    original_classifier = server.state.classifier
    try:
        server.state.classifier = fake_classifier
        result = server.redact_batch(server.TextBatch(texts=["My name is John Smith here"]))
        r = result.results[0]
        assert r.redacted == "My name is [private_person] here", repr(r.redacted)
        assert len(r.spans) == 1
        assert r.spans[0].original == "John Smith"
    finally:
        server.state.classifier = original_classifier


def test_redact_one_multi_entity_right_to_left():
    """Verifies right-to-left replacement preserves offsets when multiple spans exist."""
    import server

    # "My name is John, email john@example.com"
    #              ^11  ^15         ^23        ^39
    text = "My name is John, email john@example.com"
    assert text[11:15] == "John"
    assert text[23:39] == "john@example.com"

    def fake_classifier(_text):
        return [
            {"start": 11, "end": 15, "entity_group": "private_person"},
            {"start": 23, "end": 39, "entity_group": "private_email"},
        ]

    original_classifier = server.state.classifier
    try:
        server.state.classifier = fake_classifier
        result = server.redact_batch(
            server.TextBatch(texts=[text])
        )
        r = result.results[0]
        assert r.changed is True
        assert "[private_person]" in r.redacted
        assert "[private_email]" in r.redacted
        # Spans returned in document order (left to right)
        assert r.spans[0].label == "private_person"
        assert r.spans[0].original == "John"
        assert r.spans[1].label == "private_email"
        assert r.spans[1].original == "john@example.com"
    finally:
        server.state.classifier = original_classifier


def test_ignore_labels_skips_entities(monkeypatch):
    import server
    ents = [
        {"entity_group": "private_email", "start": 0, "end": 5},
        {"entity_group": "private_date", "start": 6, "end": 11},
    ]
    monkeypatch.setattr(server.state, "classifier", lambda t: [dict(e) for e in ents])
    monkeypatch.setenv("PII_IGNORE_LABELS", "private_date")
    r = server._redact_one("aaaaa bbbbb")
    assert r.redacted == "[private_email] bbbbb"
    assert [s.label for s in r.spans] == ["private_email"]
