import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

// ── Config ────────────────────────────────────────────────────────────────────

export interface PiiFilterConfig {
  enabled: boolean;
  logging: boolean;
  modelId: string;
  ignoreLabels: string[];
}

export function normalizeConfig(raw: unknown): PiiFilterConfig {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : false,
    logging: typeof r.logging === "boolean" ? r.logging : false,
    modelId: typeof r.modelId === "string" ? r.modelId : "openai/privacy-filter",
    ignoreLabels: Array.isArray(r.ignoreLabels)
      ? r.ignoreLabels.filter((l): l is string => typeof l === "string")
      : [],
  };
}

// ── Port finder ───────────────────────────────────────────────────────────────

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

// ── Message walking ───────────────────────────────────────────────────────────

export function collectTexts(messages: Array<{ content: unknown[] }>): string[] {
  const out: string[] = [];
  for (const msg of messages) _walkBlocks(msg.content, out);
  return out;
}

function _walkBlocks(content: unknown, out: string[]): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      out.push(b.text);
    } else if (b.type === "tool_result" && Array.isArray(b.content)) {
      _walkBlocks(b.content, out);
    }
  }
}

export function applyRedactedTexts(
  messages: Array<{ content: unknown[] }>,
  redacted: string[],
): Array<{ content: unknown[] }> {
  const copy = JSON.parse(JSON.stringify(messages)) as Array<{ content: unknown[] }>;
  let i = 0;
  for (const msg of copy) i = _patchBlocks(msg.content, redacted, i);
  return copy;
}

function _patchBlocks(content: unknown, redacted: string[], i: number): number {
  if (!Array.isArray(content)) return i;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      b.text = redacted[i++] ?? b.text;
    } else if (b.type === "tool_result" && Array.isArray(b.content)) {
      i = _patchBlocks(b.content, redacted, i);
    }
  }
  return i;
}

// ── Redact HTTP client ────────────────────────────────────────────────────────

export interface SpanInfo {
  start: number;
  end: number;
  label: string;
  original: string;
}

export interface RedactResult {
  redacted: string;
  changed: boolean;
  spans: SpanInfo[];
}

export async function redactBatch(baseUrl: string, texts: string[]): Promise<RedactResult[]> {
  if (texts.length === 0) return [];
  const resp = await fetch(`${baseUrl}/redact_batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`redact_batch failed: ${resp.status}`);
  const data = (await resp.json()) as { results: RedactResult[] };
  return data.results;
}

// ── Restart backoff ───────────────────────────────────────────────────────────

export interface RestartState {
  attempts: number;
  disabled: boolean;
}

const MAX_RESTARTS = 3;

export function resetRestartState(): RestartState {
  return { attempts: 0, disabled: false };
}

export function shouldRestart(state: RestartState): boolean {
  return !state.disabled;
}

export function recordRestartAttempt(state: RestartState): RestartState {
  const next = state.attempts + 1;
  return { attempts: next, disabled: next >= MAX_RESTARTS };
}

// ── Command parser ────────────────────────────────────────────────────────────

export type PiiCommandAction =
  | { action: "status" }
  | { action: "on" }
  | { action: "off" }
  | { action: "logOn" }
  | { action: "logOff" }
  | { action: "unknown"; input: string };

export function parsePiiCommand(args: string): PiiCommandAction {
  const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const [first, second] = parts;
  if (!first || first === "status") return { action: "status" };
  if (first === "on") return { action: "on" };
  if (first === "off") return { action: "off" };
  if (first === "log" && second === "on") return { action: "logOn" };
  if (first === "log" && second === "off") return { action: "logOff" };
  return { action: "unknown", input: args };
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

export interface ServerHandle {
  port: number;
  process: ChildProcess;
  baseUrl: string;
}

export async function spawnServer(
  projectRoot: string,
  modelId: string,
  port: number,
  ignoreLabels: string[] = [],
): Promise<ServerHandle> {
  const pythonBin = path.join(projectRoot, ".venv", "bin", "python");
  const serverDir = path.join(projectRoot, ".pi", "extensions", "pii-filter");
  const proc = spawn(
    pythonBin,
    ["-m", "uvicorn", "server:app", "--port", String(port), "--log-level", "warning"],
    {
      cwd: serverDir,
      env: {
        ...process.env,
        PII_MODEL_ID: modelId,
        PII_IGNORE_LABELS: ignoreLabels.join(","),
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  return { port, process: proc, baseUrl: `http://127.0.0.1:${port}` };
}

export function killServer(handle: ServerHandle | null): void {
  if (!handle) return;
  try {
    handle.process.kill("SIGTERM");
  } catch {
    // Already gone
  }
}

export async function pollHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// ── Extension factory ─────────────────────────────────────────────────────────

const CONFIG_FILE = "pii-filter.json";

export default function registerPiiFilter(pi: ExtensionAPI): void {
  let config: PiiFilterConfig = normalizeConfig({});
  let configPath = "";
  let projectRoot = "";
  let serverHandle: ServerHandle | null = null;
  let serverReady = false;
  let restartState: RestartState = resetRestartState();
  let errorNotifiedThisSession = false;
  let loggedMessageCount = 0;

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function loadConfig(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
      config = normalizeConfig(raw);
    } catch {
      config = normalizeConfig({});
    }
  }

  async function saveConfig(): Promise<void> {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  function setFooter(ctx: { hasUI: boolean; ui: { setStatus(id: string, v: string | undefined): void } }): void {
    if (!ctx.hasUI) return;
    if (!config.enabled) {
      ctx.ui.setStatus("pii-filter", undefined);
      return;
    }
    ctx.ui.setStatus("pii-filter", config.logging ? "🔒 PII+log" : "🔒 PII");
  }

  async function startServer(
    ctx: { hasUI: boolean; ui: { notify(msg: string, level: string): void; setStatus(id: string, v: string | undefined): void } },
  ): Promise<void> {
    serverReady = false;
    // The sidecar must run even without a UI (print/RPC mode); otherwise the
    // context hook silently passes everything through unredacted.
    const status = (v: string | undefined) => { if (ctx.hasUI) ctx.ui.setStatus("pii-filter", v); };
    const notify = (msg: string, level: string) => {
      if (ctx.hasUI) ctx.ui.notify(msg, level);
      else console.error(`[pii-filter] ${msg}`);
    };
    status("⏳ PII loading...");
    try {
      const port = await findFreePort();
      serverHandle = await spawnServer(projectRoot, config.modelId, port, config.ignoreLabels);

      serverHandle.process.on("exit", () => {
        if (!restartState.disabled && config.enabled) {
          _handleServerExit(ctx as any);
        }
      });

      const ready = await pollHealth(serverHandle.baseUrl, 120_000);
      if (!ready) {
        killServer(serverHandle);
        serverHandle = null;
        status("⚠ PII");
        notify(
          "PII Filter: server did not become ready within 120s. Run /pii on to retry.",
          "warning",
        );
        config.enabled = false;
        await saveConfig();
        return;
      }
      serverReady = true;
      errorNotifiedThisSession = false;
      setFooter(ctx as any);
    } catch (err) {
      status("⚠ PII");
      notify(`PII Filter: failed to start server — ${String(err)}`, "error");
      config.enabled = false;
      await saveConfig();
    }
  }

  function _handleServerExit(ctx: { hasUI: boolean; ui: { notify(msg: string, level: string): void; setStatus(id: string, v: string | undefined): void } }): void {
    serverHandle = null;
    serverReady = false;
    const status = (v: string | undefined) => { if (ctx.hasUI) ctx.ui.setStatus("pii-filter", v); };
    const notify = (msg: string, level: string) => {
      if (ctx.hasUI) ctx.ui.notify(msg, level);
      else console.error(`[pii-filter] ${msg}`);
    };
    if (!shouldRestart(restartState)) {
      status("⚠ PII");
      notify(
        "PII Filter: server crashed 3 times. Filtering disabled. Run /pii on to re-enable.",
        "error",
      );
      config.enabled = false;
      saveConfig().catch((e) => notify(`PII Filter: failed to persist config — ${String(e)}`, "warning"));
      return;
    }
    restartState = recordRestartAttempt(restartState);
    notify(
      `PII Filter: server exited unexpectedly (attempt ${restartState.attempts}/3), restarting in 2s...`,
      "warning",
    );
    setTimeout(async () => {
      if (!config.enabled) return;
      await startServer(ctx);
    }, 2000);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  const ALL_LABELS = ["private_person", "private_email", "private_phone", "private_address", "private_url", "private_date", "account_number", "secret"];
  function piiSystemNote(): string {
    const active = ALL_LABELS.filter((l) => !config.ignoreLabels.includes(l)).map((l) => `[${l}]`).join(", ");
    return `\n\n[PII Filter active: all personally identifiable information in this conversation has been automatically redacted and replaced with typed placeholders — ${active}. Treat these as intentional redactions of real values, not template artifacts.]`;
  }

  pi.on("before_agent_start", async (event, _ctx) => {
    loggedMessageCount = 0;
    if (!config.enabled) return;
    return { systemPrompt: event.systemPrompt + piiSystemNote() };
  });

  pi.on("session_start", async (_event, ctx) => {
    projectRoot = ctx.cwd;
    configPath = path.join(projectRoot, ".pi", CONFIG_FILE);
    restartState = resetRestartState();
    errorNotifiedThisSession = false;
    await loadConfig();
    if (config.enabled) await startServer(ctx as any);
    else setFooter(ctx as any);
  });

  pi.on("session_shutdown", async () => {
    // Detach the crash-restart handler first: the session ctx is already stale
    // here, and this exit is intentional.
    serverHandle?.process.removeAllListeners("exit");
    killServer(serverHandle);
    serverHandle = null;
    serverReady = false;
  });

  // ── Context interception ───────────────────────────────────────────────────

  pi.on("context", async (event, ctx) => {
    if (!config.enabled || !serverHandle || !serverReady) return;

    const messages = event.messages as Array<{ role: string; content: unknown[] }>;
    const texts = collectTexts(messages);
    if (texts.length === 0) return;

    let results: RedactResult[];
    try {
      results = await redactBatch(serverHandle.baseUrl, texts);
    } catch (err) {
      if (!errorNotifiedThisSession) {
        errorNotifiedThisSession = true;
        const msg = `PII Filter: redact_batch failed (${String(err)}), passing through unredacted`;
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else console.error(`[pii-filter] ${msg}`);
      }
      return;
    }

    if (results.length !== texts.length) {
      throw new Error(`PII Filter: result count mismatch (${results.length} vs ${texts.length})`);
    }
    const redactedTexts = results.map((r) => r.redacted);
    const modified = applyRedactedTexts(messages, redactedTexts);

    if (config.logging && messages.length > loggedMessageCount) {
      // Only process messages added since the last log to prevent re-logging on every context event
      const prevCount = loggedMessageCount;
      loggedMessageCount = messages.length;

      const affected: Array<{ role: string; before: string; after: string; spans: SpanInfo[] }> = [];
      let i = 0;
      for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
        const msg = messages[msgIdx]!;
        const origTexts: string[] = [];
        (function walk(content: unknown): void {
          if (!Array.isArray(content)) return;
          for (const block of content) {
            if (!block || typeof block !== "object") continue;
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") origTexts.push(b.text);
            else if (b.type === "tool_result" && Array.isArray(b.content)) walk(b.content);
          }
        })(msg.content);
        for (const orig of origTexts) {
          const result = results[i++];
          if (result?.changed && msgIdx >= prevCount) {
            affected.push({ role: msg.role, before: orig, after: result.redacted, spans: result.spans });
          }
        }
      }
      if (affected.length > 0 && ctx.hasUI) {
        const totalSpans = affected.reduce((sum, a) => sum + a.spans.length, 0);
        const truncate = (s: string) => s.length > 500 ? `${s.slice(0, 500)}…` : s;
        const lines = [`[PII Filter] ${totalSpans} span(s) redacted — ${affected.length} message(s) affected`];
        for (const item of affected) {
          lines.push(`  [${item.role}] Before: ${truncate(item.before)}`);
          lines.push(`         After:  ${truncate(item.after)}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
      }
    }

    return { messages: modified };
  });

  // ── Commands ───────────────────────────────────────────────────────────────

  pi.registerCommand("pii", {
    description: "Toggle PII filtering and logging (/pii [on|off|log on|log off|status])",
    handler: async (args, ctx) => {
      const cmd = parsePiiCommand(args ?? "");

      if (cmd.action === "status") {
        const serverStatus = serverHandle ? "running" : "stopped";
        ctx.ui.notify(
          `PII Filter — enabled: ${config.enabled}, logging: ${config.logging}, server: ${serverStatus}, model: ${config.modelId}, ignoreLabels: ${config.ignoreLabels.join(",") || "none"}`,
          "info",
        );
        return;
      }

      if (cmd.action === "on") {
        if (config.enabled) { ctx.ui.notify("PII Filter already on", "info"); return; }
        config.enabled = true;
        await saveConfig();
        restartState = resetRestartState();
        errorNotifiedThisSession = false;
        await startServer(ctx as any);
        return;
      }

      if (cmd.action === "off") {
        config.enabled = false;
        restartState = { ...restartState, disabled: true };
        await saveConfig();
        killServer(serverHandle);
        serverHandle = null;
        setFooter(ctx as any);
        ctx.ui.notify("PII Filter disabled", "info");
        return;
      }

      if (cmd.action === "logOn") {
        config.logging = true;
        await saveConfig();
        setFooter(ctx as any);
        ctx.ui.notify("PII Filter logging enabled", "info");
        return;
      }

      if (cmd.action === "logOff") {
        config.logging = false;
        await saveConfig();
        setFooter(ctx as any);
        ctx.ui.notify("PII Filter logging disabled", "info");
        return;
      }

      ctx.ui.notify(`Unknown subcommand. Usage: /pii [on|off|log on|log off|status]`, "error");
    },
  });

  // ── Keyboard shortcut ──────────────────────────────────────────────────────

  pi.registerShortcut("alt+shift+p", {
    description: "Cycle PII filter: off → on → on+log → off",
    handler: async (ctx) => {
      if (!config.enabled) {
        config.enabled = true;
        config.logging = false;
        await saveConfig();
        restartState = resetRestartState();
        errorNotifiedThisSession = false;
        await startServer(ctx as any);
      } else if (!config.logging) {
        config.logging = true;
        await saveConfig();
        setFooter(ctx as any);
        ctx.ui.notify("PII Filter: logging enabled", "info");
      } else {
        config.enabled = false;
        config.logging = false;
        restartState = { ...restartState, disabled: true };
        await saveConfig();
        killServer(serverHandle);
        serverHandle = null;
        setFooter(ctx as any);
        ctx.ui.notify("PII Filter: disabled", "info");
      }
    },
  });

}
