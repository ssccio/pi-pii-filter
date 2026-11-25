import { describe, it, expect, vi, afterEach } from "vitest";
import {
  normalizeConfig,
  findFreePort,
  collectTexts,
  applyRedactedTexts,
  redactBatch,
  shouldRestart,
  recordRestartAttempt,
  resetRestartState,
  parsePiiCommand,
} from "../index.js";

describe("normalizeConfig", () => {
  it("returns defaults for empty object", () => {
    const cfg = normalizeConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.logging).toBe(false);
    expect(cfg.modelId).toBe("openai/privacy-filter");
  });

  it("returns defaults for null/undefined", () => {
    expect(normalizeConfig(null).enabled).toBe(false);
    expect(normalizeConfig(undefined).enabled).toBe(false);
  });

  it("preserves valid boolean fields", () => {
    const cfg = normalizeConfig({ enabled: true, logging: true });
    expect(cfg.enabled).toBe(true);
    expect(cfg.logging).toBe(true);
  });

  it("preserves modelId string", () => {
    const cfg = normalizeConfig({ modelId: "openai/custom-filter" });
    expect(cfg.modelId).toBe("openai/custom-filter");
  });

  it("ignores unknown fields", () => {
    const cfg = normalizeConfig({ enabled: true, unknownField: "ignored" });
    expect(cfg.enabled).toBe(true);
    expect((cfg as any).unknownField).toBeUndefined();
  });

  it("coerces non-boolean enabled to false", () => {
    const cfg = normalizeConfig({ enabled: "yes" });
    expect(cfg.enabled).toBe(false);
  });
});

describe("findFreePort", () => {
  it("returns a number in valid unprivileged port range", async () => {
    const port = await findFreePort();
    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65535);
  });

  it("returns a different port on consecutive calls", async () => {
    const p1 = await findFreePort();
    const p2 = await findFreePort();
    expect(p1).not.toBe(p2);
  });
});

describe("collectTexts", () => {
  it("extracts text blocks from a simple user message", () => {
    const messages = [
      { content: [{ type: "text", text: "Hello world" }] },
    ];
    expect(collectTexts(messages)).toEqual(["Hello world"]);
  });

  it("extracts text from multiple messages", () => {
    const messages = [
      { content: [{ type: "text", text: "first" }] },
      { content: [{ type: "text", text: "second" }] },
    ];
    expect(collectTexts(messages)).toEqual(["first", "second"]);
  });

  it("extracts text nested inside tool_result", () => {
    const messages = [
      {
        content: [
          {
            type: "tool_result",
            tool_use_id: "abc",
            content: [{ type: "text", text: "bash output" }],
          },
        ],
      },
    ];
    expect(collectTexts(messages)).toEqual(["bash output"]);
  });

  it("skips non-text blocks", () => {
    const messages = [
      {
        content: [
          { type: "image_url", url: "https://example.com/img.png" },
          { type: "text", text: "caption" },
        ],
      },
    ];
    expect(collectTexts(messages)).toEqual(["caption"]);
  });

  it("returns empty array for messages with no text blocks", () => {
    const messages = [{ content: [] }];
    expect(collectTexts(messages)).toEqual([]);
  });
});

describe("applyRedactedTexts", () => {
  it("replaces text blocks in document order", () => {
    const messages = [
      { content: [{ type: "text", text: "original" }] },
    ];
    const result = applyRedactedTexts(messages, ["[private_person]"]);
    expect((result[0]!.content[0] as any).text).toBe("[private_person]");
  });

  it("does not mutate the original messages array", () => {
    const messages = [{ content: [{ type: "text", text: "original" }] }];
    applyRedactedTexts(messages, ["replaced"]);
    expect((messages[0]!.content[0] as any).text).toBe("original");
  });

  it("replaces text in nested tool_result blocks", () => {
    const messages = [
      {
        content: [
          {
            type: "tool_result",
            tool_use_id: "abc",
            content: [{ type: "text", text: "bash output with PII" }],
          },
        ],
      },
    ];
    const result = applyRedactedTexts(messages, ["bash output with [private_email]"]);
    const nested = (result[0]!.content[0] as any).content[0];
    expect(nested.text).toBe("bash output with [private_email]");
  });

  it("replaces across multiple messages in order", () => {
    const messages = [
      { content: [{ type: "text", text: "a" }] },
      { content: [{ type: "text", text: "b" }] },
    ];
    const result = applyRedactedTexts(messages, ["A", "B"]);
    expect((result[0]!.content[0] as any).text).toBe("A");
    expect((result[1]!.content[0] as any).text).toBe("B");
  });
});

describe("redactBatch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns empty array for empty input without fetching", async () => {
    const spy = vi.spyOn(global, "fetch");
    const results = await redactBatch("http://localhost:9999", []);
    expect(results).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("posts texts to /redact_batch and returns results", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { redacted: "[private_person]", changed: true, spans: [{ start: 0, end: 4, label: "private_person", original: "John" }] },
        ],
      }),
    } as Response);

    const results = await redactBatch("http://localhost:8765", ["John"]);
    expect(results).toHaveLength(1);
    expect(results[0]!.redacted).toBe("[private_person]");
    expect(results[0]!.changed).toBe(true);
    expect(results[0]!.spans[0]!.label).toBe("private_person");
  });

  it("throws on non-ok HTTP response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 503,
    } as Response);

    await expect(redactBatch("http://localhost:8765", ["text"])).rejects.toThrow("503");
  });
});

describe("restart backoff", () => {
  it("fresh state allows restart", () => {
    expect(shouldRestart(resetRestartState())).toBe(true);
  });

  it("records attempts and disables after 3", () => {
    let s = resetRestartState();
    s = recordRestartAttempt(s); expect(shouldRestart(s)).toBe(true);  // 1
    s = recordRestartAttempt(s); expect(shouldRestart(s)).toBe(true);  // 2
    s = recordRestartAttempt(s); expect(shouldRestart(s)).toBe(false); // 3 → disabled
  });

  it("resetRestartState clears disabled flag", () => {
    let s = resetRestartState();
    s = recordRestartAttempt(s);
    s = recordRestartAttempt(s);
    s = recordRestartAttempt(s);
    expect(shouldRestart(s)).toBe(false);
    expect(shouldRestart(resetRestartState())).toBe(true);
  });
});

describe("parsePiiCommand", () => {
  it("empty args → status", () => {
    expect(parsePiiCommand("").action).toBe("status");
  });

  it('"status" → status', () => {
    expect(parsePiiCommand("status").action).toBe("status");
  });

  it('"on" → on', () => {
    expect(parsePiiCommand("on").action).toBe("on");
  });

  it('"off" → off', () => {
    expect(parsePiiCommand("off").action).toBe("off");
  });

  it('"log on" → logOn', () => {
    expect(parsePiiCommand("log on").action).toBe("logOn");
  });

  it('"log off" → logOff', () => {
    expect(parsePiiCommand("log off").action).toBe("logOff");
  });

  it("unknown input → unknown with original", () => {
    const result = parsePiiCommand("foo bar") as { action: string; input: string };
    expect(result.action).toBe("unknown");
    expect(result.input).toBe("foo bar");
  });

  it("is case-insensitive", () => {
    expect(parsePiiCommand("ON").action).toBe("on");
    expect(parsePiiCommand("LOG OFF").action).toBe("logOff");
  });
});

describe("normalizeConfig ignoreLabels", () => {
  it("defaults to empty", () => {
    expect(normalizeConfig({}).ignoreLabels).toEqual([]);
  });
  it("keeps only strings", () => {
    expect(normalizeConfig({ ignoreLabels: ["private_url", 3, null] }).ignoreLabels).toEqual(["private_url"]);
  });
  it("rejects non-arrays", () => {
    expect(normalizeConfig({ ignoreLabels: "private_url" }).ignoreLabels).toEqual([]);
  });
});
