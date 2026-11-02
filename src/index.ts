import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { executeAsk } from "./ask.js";
import { readConfig, type Config } from "./config.js";
import { definition } from "./schema.js";
import { Transport } from "./transport.js";
import { acquireLock } from "./lock.js";
import { TransportLifecycle } from "./lifecycle.js";
import {
  createTelegramInteractionService,
  registerTelegramInteractionService,
} from "./service.js";

export default function extension(pi: ExtensionAPI) {
  let config: Config | undefined; let startupError: string | undefined;
  let notifyFailure: ((reason: string) => void) | undefined;
  const lifecycle = new TransportLifecycle(() => {
    const nextConfig = readConfig();
    const release = acquireLock(nextConfig.token);
    config = nextConfig;
    return release;
  }, () => new Transport(config!), reason => notifyFailure?.(reason));
  const interactionService = createTelegramInteractionService(
    lifecycle,
    () => config,
  );
  registerTelegramInteractionService(pi, interactionService);
  pi.on("session_start", async (_event, ctx) => {
    notifyFailure = reason => ctx.ui.notify(`Telegram ask_user: ${reason}`, "error");
    try { await lifecycle.start(); startupError = undefined; }
    catch (e) { startupError = (e as Error).message; if (!lifecycle.failure) ctx.ui.notify(`Telegram ask_user: ${startupError}`, "error"); }
  });
  pi.on("session_shutdown", async () => { try { await lifecycle.shutdown(); startupError = undefined; } finally { notifyFailure = undefined; } });
  pi.registerCommand("telegram-status", { description: "Show Telegram ask_user status", handler: async (_args, ctx) => {
    const transport = lifecycle.transport;
    const issue = lifecycle.failure ?? startupError;
    const state = issue ? "FAILED" : lifecycle.state;
    ctx.ui.notify(`Telegram transport: ${state}${issue ? `; ${issue}` : `; connectivity ${transport?.connected ? "available" : "not confirmed"}`}; pending ${transport?.count ?? 0}`, issue ? "warning" : "info");
  } });
  pi.registerTool({ ...definition, async execute(callId, params, signal, _onUpdate, ctx) {
    if (signal?.aborted) return { content: [{ type: "text" as const, text: "Cancelled" }], details: params.questions != null ? { kind: "batch", questions: [], answers: [], cancelled: true } : { question: params.question, options: [], response: null, cancelled: true } };
    const transport = lifecycle.transport;
    if (!transport || !config) throw new Error(`Telegram ask_user unavailable: ${lifecycle.failure ?? startupError ?? "session not started"}`);
    return executeAsk(transport, callId, params, signal, basename(ctx.cwd), pi.events, config.timeout);
  } });
}
