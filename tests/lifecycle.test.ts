import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";
import { acquireLock } from "../src/lock.js";
import { TransportLifecycle } from "../src/lifecycle.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function outcome<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test("concurrent starts share ownership; shutdown waits for startup and allows restart", async () => {
  const ready = deferred(); let locks = 0; let releases = 0; let created = 0; let started = 0; let disposed = 0;
  const lifecycle = new TransportLifecycle(() => { locks++; return () => { releases++; }; }, () => {
    created++; return { async start() { started++; await ready.promise; }, async dispose() { disposed++; } };
  });
  const first = lifecycle.start(); const second = lifecycle.start(); assert.strictEqual(first, second);
  await Promise.resolve(); assert.equal(locks, 1); assert.equal(created, 1); assert.equal(started, 1);
  const stop = lifecycle.shutdown(); assert.strictEqual(stop, lifecycle.shutdown());
  const restart = lifecycle.start(); ready.resolve(); await Promise.all([first, second, stop, restart]);
  assert.equal(locks, 2); assert.equal(releases, 1); assert.equal(created, 2); assert.equal(disposed, 1);
  await lifecycle.start(); assert.equal(locks, 2);
  await Promise.all([lifecycle.shutdown(), lifecycle.shutdown()]); assert.equal(releases, 2); assert.equal(disposed, 2); assert.equal(lifecycle.transport, undefined);
});

test("failed startup disposes partial transport, releases lock and can be retried", async () => {
  let attempts = 0; let releases = 0; let disposed = 0;
  const lifecycle = new TransportLifecycle(() => () => { releases++; }, () => ({
    async start() { if (++attempts === 1) throw new Error("startup failed"); },
    async dispose() { disposed++; },
  }));
  await assert.rejects(lifecycle.start(), /startup failed/);
  assert.equal(releases, 1); assert.equal(disposed, 1); assert.equal(lifecycle.transport, undefined);
  await lifecycle.start(); assert.ok(lifecycle.transport); await lifecycle.shutdown(); assert.equal(releases, 2); assert.equal(disposed, 2);
});

test("Pi session events start one poller and release the lock on repeated shutdown and restart", async () => {
  const token = randomUUID(); const previousFetch = globalThis.fetch;
  const previous = { ...process.env }; let polls = 0; let aborts = 0;
  process.env.PI_TELEGRAM_BOT_TOKEN = token; process.env.PI_TELEGRAM_CHAT_ID = "123"; process.env.PI_TELEGRAM_USER_ID = "123";
  globalThis.fetch = (async (_url, options) => {
    polls++;
    return new Promise<Response>((_resolve, reject) => {
      const signal = options?.signal;
      const abort = () => { aborts++; reject(new Error("aborted")); };
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;
  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  const pi = { on: (name: string, handler: (...args: any[]) => Promise<void>) => handlers.set(name, handler), registerCommand() {}, registerTool() {}, events: { emit() {}, on() { return () => {}; } } };
  const ctx = { ui: { notify() {} } };
  try {
    extension(pi as unknown as ExtensionAPI);
    const start = handlers.get("session_start")!; const stop = handlers.get("session_shutdown")!;
    await Promise.all([start({}, ctx), start({}, ctx), start({}, ctx)]);
    assert.equal(polls, 1); assert.throws(() => acquireLock(token), /poller/);
    await start({}, ctx); assert.equal(polls, 1);
    await Promise.all([stop({}, ctx), stop({}, ctx)]); assert.equal(aborts, 1);
    const released = acquireLock(token); released();
    await start({}, ctx); assert.equal(polls, 2); await stop({}, ctx); assert.equal(aborts, 2);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    globalThis.fetch = previousFetch;
    for (const key of ["PI_TELEGRAM_BOT_TOKEN", "PI_TELEGRAM_CHAT_ID", "PI_TELEGRAM_USER_ID"]) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

test("failure invalidates transport immediately and concurrent recovery waits for cleanup", async () => {
  const completed = outcome<string | undefined>(); const cleanupGate = deferred(); let locks = 0; let releases = 0; let created = 0; let disposed = 0; const failures: string[] = [];
  const lifecycle = new TransportLifecycle(() => { locks++; return () => { releases++; }; }, () => {
    const generation = ++created;
    return { completion: generation === 1 ? completed.promise : new Promise<string | undefined>(() => {}), start() {}, async dispose() { disposed++; if (generation === 1) await cleanupGate.promise; } };
  }, reason => failures.push(reason));
  await lifecycle.start(); assert.equal(lifecycle.state, "RUNNING");
  completed.resolve("Telegram API HTTP 409"); await tick();
  assert.equal(lifecycle.state, "FAILED"); assert.equal(lifecycle.transport, undefined); assert.deepEqual(failures, ["Telegram API HTTP 409"]);
  const first = lifecycle.start(); const second = lifecycle.start(); await tick();
  assert.equal(created, 1); assert.equal(locks, 1); assert.equal(disposed, 1);
  cleanupGate.resolve(); await Promise.all([first, second]);
  assert.equal(created, 2); assert.equal(locks, 2); assert.equal(releases, 1); assert.equal(lifecycle.state, "RUNNING");
  await Promise.all([lifecycle.shutdown(), lifecycle.shutdown()]); assert.equal(disposed, 2); assert.equal(releases, 2); assert.equal(lifecycle.state, "STOPPED");
});

test("restart observes failure even before the completion notification arrives", async () => {
  const ended = outcome<string | undefined>(); const gate = deferred(); let reason: string | undefined; let created = 0; let released = 0;
  const lifecycle = new TransportLifecycle(() => () => { released++; }, () => {
    const generation = ++created;
    return { completion: generation === 1 ? ended.promise : new Promise<string | undefined>(() => {}), get failure() { return generation === 1 ? reason : undefined; }, start() {}, async dispose() { if (generation === 1) await gate.promise; } };
  });
  await lifecycle.start(); reason = "Telegram API HTTP 401";
  const restart = lifecycle.start(); await tick(); assert.equal(created, 1); assert.equal(lifecycle.state, "FAILED");
  gate.resolve(); await restart; assert.equal(created, 2); assert.equal(released, 1);
  ended.resolve(reason); await tick(); assert.equal(lifecycle.state, "RUNNING"); await lifecycle.shutdown();
});

test("poll completion before startup finishes fails once and cleans the lock", async () => {
  const started = deferred(); const completed = outcome<string | undefined>(); let releases = 0; let disposals = 0; const failures: string[] = [];
  const lifecycle = new TransportLifecycle(() => () => { releases++; }, () => ({ completion: completed.promise, start: () => started.promise, dispose() { disposals++; } }), reason => failures.push(reason));
  const start = lifecycle.start(); await Promise.resolve(); completed.resolve("Telegram API HTTP 401"); await tick();
  assert.equal(lifecycle.state, "FAILED"); assert.equal(lifecycle.transport, undefined);
  started.resolve(); await assert.rejects(start, /401/); await tick();
  assert.equal(releases, 1); assert.equal(disposals, 1); assert.deepEqual(failures, ["Telegram API HTTP 401"]); await lifecycle.shutdown();
});

test("unexpected completion or rejection is sanitized, and a late old completion cannot invalidate a replacement", async () => {
  const old = outcome<string | undefined>(); const current = outcome<string | undefined>(); let count = 0;
  const lifecycle = new TransportLifecycle(() => () => {}, () => ({ completion: ++count === 1 ? old.promise : current.promise, start() {}, dispose() {} }));
  await lifecycle.start(); await lifecycle.shutdown(); await lifecycle.start(); old.reject(new Error("secret token")); await tick();
  assert.equal(lifecycle.state, "RUNNING"); current.reject(new Error("secret token")); await tick();
  assert.equal(lifecycle.state, "FAILED"); assert.doesNotMatch(lifecycle.failure!, /secret/); await lifecycle.shutdown();
  const resolved = outcome<string | undefined>(); const other = new TransportLifecycle(() => () => {}, () => ({ completion: resolved.promise, start() {}, dispose() {} }));
  await other.start(); resolved.resolve(undefined); await tick(); assert.equal(other.state, "FAILED"); assert.match(other.failure!, /unexpectedly/); await other.shutdown();
});

test("shutdown during failure cleanup waits and leaves no active transport", async () => {
  const completed = outcome<string | undefined>(); const gate = deferred(); let released = 0; let disposed = 0;
  const lifecycle = new TransportLifecycle(() => () => { released++; }, () => ({ completion: completed.promise, start() {}, async dispose() { disposed++; await gate.promise; } }));
  await lifecycle.start(); completed.resolve("failure"); await tick(); const shutdown = lifecycle.shutdown(); await tick(); assert.equal(released, 0);
  gate.resolve(); await shutdown; assert.equal(released, 1); assert.equal(disposed, 1); assert.equal(lifecycle.state, "STOPPED");
});

test("shutdown cancels a queued recovery without starting another poller", async () => {
  const completed = outcome<string | undefined>(); const gate = deferred(); let created = 0;
  const lifecycle = new TransportLifecycle(() => () => {}, () => { created++; return { completion: completed.promise, start() {}, async dispose() { await gate.promise; } }; });
  await lifecycle.start(); completed.resolve("failure"); await tick();
  const recovery = lifecycle.start(); const shutdown = lifecycle.shutdown(); gate.resolve();
  await Promise.all([recovery, shutdown]); assert.equal(created, 1); assert.equal(lifecycle.state, "STOPPED");
});

test("explicit transport disposal is expected and releases lifecycle ownership", async () => {
  const completed = outcome<string | undefined>(); let disposed = false; let releases = 0; const failures: string[] = [];
  const transport = { completion: completed.promise, get disposed() { return disposed; }, start() {}, dispose() { disposed = true; completed.resolve(undefined); } };
  const lifecycle = new TransportLifecycle(() => () => { releases++; }, () => transport, reason => failures.push(reason));
  await lifecycle.start(); transport.dispose(); await tick();
  assert.equal(lifecycle.state, "STOPPED"); assert.equal(lifecycle.transport, undefined); assert.equal(releases, 1); assert.deepEqual(failures, []); await lifecycle.shutdown();
});

for (const code of [401, 409]) test(`HTTP ${code} cancels pending work, releases ownership, reports failure and restarts only on session start`, async () => {
  const token = `test-${randomUUID()}`; const oldFetch = globalThis.fetch; const oldEnv = { ...process.env };
  process.env.PI_TELEGRAM_BOT_TOKEN = token; process.env.PI_TELEGRAM_CHAT_ID = "123"; process.env.PI_TELEGRAM_USER_ID = "123";
  let polls = 0; let failPoll!: (response: Response) => void; const notifications: string[] = [];
  globalThis.fetch = (async (input, options) => {
    const url = String(input);
    if (url.endsWith("/getUpdates")) {
      polls++;
      return new Promise<Response>((resolve, reject) => {
        if (polls === 1) failPoll = resolve;
        const signal = options?.signal; const abort = () => reject(new Error("aborted"));
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return new Response(JSON.stringify({ ok: true, result: url.endsWith("/sendMessage") ? { message_id: 100 } : true }), { status: 200 });
  }) as typeof fetch;
  const handlers = new Map<string, (...args: any[]) => Promise<void>>(); let tool: any; let command: any;
  const pi = { on: (name: string, handler: (...args: any[]) => Promise<void>) => handlers.set(name, handler), registerCommand(_name: string, value: unknown) { command = value; }, registerTool(value: unknown) { tool = value; }, events: { emit() {}, on() { return () => {}; } } };
  const ctx = { cwd: "G:\\Projects\\example", ui: { notify(message: string) { notifications.push(message); } } };
  try {
    extension(pi as unknown as ExtensionAPI); const start = handlers.get("session_start")!; const stop = handlers.get("session_shutdown")!;
    await start({}, ctx); const answer = tool.execute("call", { question: "Pending question" }, undefined, undefined, ctx); await tick();
    failPoll(new Response(JSON.stringify({ ok: false, error_code: code, description: token }), { status: code }));
    const result = await answer; assert.equal(result.content[0].text, "User cancelled the question"); assert.equal(result.details.cancelled, true);
    await tick(); await command.handler("", ctx); assert.match(notifications.at(-1)!, new RegExp(`FAILED.*${code}`)); assert.ok(notifications.every(x => !x.includes(token)));
    assert.equal(notifications.filter(x => x.includes(`HTTP ${code}`) && !x.includes("transport:")).length, 1);
    const released = acquireLock(token); released(); assert.equal(polls, 1);
    await Promise.all([start({}, ctx), start({}, ctx)]); assert.equal(polls, 2);
    await command.handler("", ctx); assert.match(notifications.at(-1)!, /RUNNING/); await stop({}, ctx); await stop({}, ctx);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx); globalThis.fetch = oldFetch;
    for (const key of ["PI_TELEGRAM_BOT_TOKEN", "PI_TELEGRAM_CHAT_ID", "PI_TELEGRAM_USER_ID"]) {
      if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key];
    }
  }
});
