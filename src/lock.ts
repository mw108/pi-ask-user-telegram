import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Never steal a lock automatically: PID reuse and partially written owners cannot
// be distinguished reliably. The operator can remove a verified stale lock.
export function acquireLock(token: string): () => void {
  const path = join(tmpdir(), `pi-telegram-${createHash("sha256").update(token).digest("hex").slice(0, 24)}.lock`);
  const owner = `${process.pid}:${randomBytes(16).toString("hex")}`;
  try { mkdirSync(path, { mode: 0o700 }); } catch { throw new Error(`Another local poller may own this bot. Stop it; if no poller is running, remove stale lock directory ${path}.`); }
  try { writeFileSync(join(path, "owner"), owner, { mode: 0o600 }); } catch { rmSync(path, { recursive: true, force: true }); throw new Error("Unable to establish Telegram polling ownership"); }
  return () => { try { if (readFileSync(join(path, "owner"), "utf8") === owner) rmSync(path, { recursive: true, force: true }); } catch { /* already released */ } };
}
