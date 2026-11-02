import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.js";
import type { Transport } from "./transport.js";

export const TELEGRAM_INTERACTION_DISCOVERY_CHANNEL =
  "pi-ask-user-telegram:interaction-service:v1";
export const TELEGRAM_INTERACTION_PROTOCOL_VERSION = 1 as const;

export type TelegramInteractionOption = {
  id: string;
  label: string;
  description?: string;
};

export type TelegramInteractionRequest = {
  id: string;
  title: string;
  message: string;
  project?: string;
  options?: TelegramInteractionOption[];
  multiple?: boolean;
  allowText?: boolean;
  details?: string;
  timeoutMs?: number;
};

export type TelegramInteractionResponse = {
  requestId: string;
  selectedOptionIds: string[];
  text?: string;
  cancelled: boolean;
};

export interface TelegramInteractionService {
  readonly protocolVersion: typeof TELEGRAM_INTERACTION_PROTOCOL_VERSION;
  readonly state: "STOPPED" | "STARTING" | "RUNNING" | "STOPPING" | "FAILED";
  readonly failure?: string;
  readonly pendingCount: number;
  request(
    request: TelegramInteractionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<TelegramInteractionResponse>;
}

export type TelegramInteractionDiscovery = {
  protocolVersion: number;
  accept(service: TelegramInteractionService): void;
};

type Lifecycle = {
  readonly state: TelegramInteractionService["state"];
  readonly failure?: string;
  readonly transport?: Transport;
};

function validateRequest(request: TelegramInteractionRequest) {
  if (!request.id.trim()) throw new Error("Telegram interaction requires an id");
  if (!request.title.trim())
    throw new Error("Telegram interaction requires a title");
  if (!request.message.trim())
    throw new Error("Telegram interaction requires a message");
  if (
    request.timeoutMs !== undefined &&
    (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 0)
  )
    throw new Error("Telegram interaction timeoutMs must be zero or positive");
  const options = request.options ?? [];
  if (new Set(options.map((option) => option.id)).size !== options.length)
    throw new Error("Telegram interaction option ids must be unique");
  if (options.some((option) => !option.id.trim() || !option.label.trim()))
    throw new Error("Telegram interaction options require ids and labels");
}

export function createTelegramInteractionService(
  lifecycle: Lifecycle,
  getConfig: () => Config | undefined,
): TelegramInteractionService {
  return {
    protocolVersion: TELEGRAM_INTERACTION_PROTOCOL_VERSION,
    get state() {
      return lifecycle.state;
    },
    get failure() {
      return lifecycle.failure;
    },
    get pendingCount() {
      return lifecycle.transport?.count ?? 0;
    },
    async request(request, options = {}) {
      validateRequest(request);
      const transport = lifecycle.transport;
      const config = getConfig();
      if (!transport || !config)
        throw new Error(
          `Telegram interaction service unavailable: ${lifecycle.failure ?? `transport ${lifecycle.state.toLowerCase()}`}`,
        );
      const controller = new AbortController();
      const abort = () => controller.abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      try {
        const details =
          request.details ??
          (request.message.length > 3000 ? request.message : undefined);
        const message =
          details && request.message.length > 1800
            ? `${request.message.slice(0, 1800)}\n\n[Summary shortened for Telegram. Use View details for the complete content.]`
            : request.message;
        const answer = await transport.ask(
          request.id,
          {
            title: request.title,
            question: message,
            options: (request.options ?? []).map((option) => ({
              id: option.id,
              title:
                details && option.label.length > 80
                  ? `${option.label.slice(0, 62)}… (see details)`
                  : option.label,
              description: option.description,
            })),
            allowMultiple: request.multiple ?? false,
            allowFreeform: request.allowText ?? false,
            details,
            listOptions: !details,
            rejectOnFailure: true,
          },
          false,
          false,
          request.project ?? "",
          controller.signal,
          request.timeoutMs ?? 0,
        );
        if (answer === null || answer === "skip")
          return {
            requestId: request.id,
            selectedOptionIds: [],
            cancelled: true,
          };
        if (answer.kind === "freeform")
          return {
            requestId: request.id,
            selectedOptionIds: [],
            text: answer.text,
            cancelled: false,
          };
        return {
          requestId: request.id,
          selectedOptionIds: answer.selectionIds ?? [],
          ...(answer.comment ? { text: answer.comment } : {}),
          cancelled: false,
        };
      } finally {
        options.signal?.removeEventListener("abort", abort);
      }
    },
  };
}

/** Register the lifecycle-owned service on Pi's documented extension event bus. */
export function registerTelegramInteractionService(
  pi: ExtensionAPI,
  service: TelegramInteractionService,
) {
  return pi.events.on(TELEGRAM_INTERACTION_DISCOVERY_CHANNEL, (value) => {
    const discovery = value as Partial<TelegramInteractionDiscovery> | undefined;
    if (
      discovery?.protocolVersion === TELEGRAM_INTERACTION_PROTOCOL_VERSION &&
      typeof discovery.accept === "function"
    )
      discovery.accept(service);
  });
}
