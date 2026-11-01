type ManagedTransport = {
  start(): void | Promise<void>;
  dispose(): void | Promise<void>;
  readonly completion?: Promise<string | undefined>;
  readonly failure?: string;
  readonly disposed?: boolean;
};
type Slot<T> = { transport: T; release: () => void; failed?: string; ending?: boolean; cleanup?: Promise<void> };

/** Owns one transport and lock, including while a failed poller is being cleaned up. */
export class TransportLifecycle<T extends ManagedTransport> {
  private slot?: Slot<T>;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private failureCleanup?: Promise<void>;
  private running = false;
  private failedReason?: string;
  private cleanupFailed = false;
  private shutdownGeneration = 0;

  constructor(private acquire: () => () => void, private create: () => T, private onFailure: (reason: string) => void = () => {}) {}

  get state(): "STOPPED" | "STARTING" | "RUNNING" | "STOPPING" | "FAILED" {
    if (this.failedReason || this.slot?.transport.failure) return "FAILED";
    if (this.stopping) return "STOPPING";
    if (this.starting) return "STARTING";
    return this.running && this.slot ? "RUNNING" : "STOPPED";
  }
  get failure(): string | undefined { return this.failedReason ?? this.slot?.transport.failure; }
  get transport(): T | undefined {
    return this.running && !this.stopping && !this.slot?.failed && !this.slot?.transport.failure ? this.slot?.transport : undefined;
  }

  private cleanup(slot: Slot<T>): Promise<void> {
    if (!slot.cleanup) {
      slot.cleanup = Promise.resolve().then(async () => {
        try { if (!slot.transport.disposed) await slot.transport.dispose(); } finally {
          try { slot.release(); } finally { if (this.slot === slot) this.slot = undefined; }
        }
      });
    }
    return slot.cleanup;
  }

  private ended(slot: Slot<T>, reason: string | undefined) {
    if (this.slot !== slot || this.stopping || slot.ending) return;
    slot.ending = true;
    slot.failed = reason;
    this.running = false;
    if (reason) {
      this.failedReason = reason;
      try { this.onFailure(reason); } catch { /* notification cannot break cleanup */ }
    }
    const operation = Promise.resolve().then(async () => {
      try { await this.starting; } catch { /* startup cleans its own resources */ }
      await this.cleanup(slot);
    });
    const barrier = operation.catch(() => { this.cleanupFailed = true; this.failedReason = "Telegram transport cleanup failed; restart Pi and check the local lock."; });
    this.failureCleanup = barrier;
    void barrier.then(() => { if (this.failureCleanup === barrier) this.failureCleanup = undefined; });
  }

  start(): Promise<void> {
    if (this.stopping) return this.stopping.then(() => this.start());
    // The transport marks itself failed before its completion callback runs.
    // Do not attempt to acquire its still-held lock in that microtask window.
    if (this.slot?.transport.failure && !this.slot.ending) this.ended(this.slot, this.slot.transport.failure);
    if (this.failureCleanup) {
      const generation = this.shutdownGeneration;
      return this.failureCleanup.then(() => generation === this.shutdownGeneration ? this.start() : undefined);
    }
    if (this.starting) return this.starting;
    if (this.cleanupFailed) return Promise.reject(new Error(this.failedReason));
    if (this.transport) return Promise.resolve();

    const operation = Promise.resolve().then(async () => {
      let release: (() => void) | undefined;
      let slot: Slot<T> | undefined;
      try {
        release = this.acquire();
        slot = { transport: this.create(), release };
        this.slot = slot;
        const started = slot.transport.start();
        const observed = slot;
        // Install both handlers immediately, including for already-settled promises.
        void slot.transport.completion?.then(
          reason => this.ended(observed, reason ?? (observed.transport.disposed || this.stopping ? undefined : "Telegram polling stopped unexpectedly.")),
          () => this.ended(observed, "Telegram polling stopped unexpectedly."),
        );
        await started;
        if (slot.ending || slot.transport.failure || slot.transport.disposed) throw new Error(slot.failed ?? slot.transport.failure ?? "Telegram transport stopped during startup.");
        this.running = true;
        this.failedReason = undefined;
      } catch (error) {
        this.running = false;
        if (slot) { try { await this.cleanup(slot); } catch { /* preserve startup error */ } }
        else { try { release?.(); } catch { /* preserve startup error */ } }
        throw error;
      }
    });
    this.starting = operation.finally(() => { this.starting = undefined; });
    return this.starting;
  }

  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.shutdownGeneration++;
    const operation = Promise.resolve().then(async () => {
      try { await this.starting; } catch { /* startup callers receive the error */ }
      await this.failureCleanup;
      this.running = false;
      if (this.slot) await this.cleanup(this.slot);
      if (this.cleanupFailed) throw new Error(this.failedReason);
      this.failedReason = undefined;
    });
    this.stopping = operation.finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
}
