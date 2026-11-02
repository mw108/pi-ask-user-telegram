# pi-ask-user-telegram

A standalone Pi extension that sends `ask_user` questions to a private Telegram chat and waits for an authorized answer. It does not require Pi-Team. It targets Pi 1.4.0 and Node 22 or later; it was developed against the installed `pi-ask-user` 0.17.1. The npm installation form `pi install npm:pi-ask-user-telegram` is a future distribution target; this package has not been published by this project.

## Setup

1. In Telegram, talk to [BotFather](https://t.me/BotFather), create a bot with `/newbot`, and keep the token private. Start a private conversation with the new bot and send it a message.
2. Before starting any poller, retrieve the IDs from the bot's pending updates. For example, in PowerShell, the following prompts for the token without echoing it and prints only the chat and sender IDs. Run it on a trusted machine and do not share the token or raw updates:

   ```powershell
   $botSecret = Read-Host 'Bot token' -AsSecureString
   $botCredential = [System.Management.Automation.PSCredential]::new('bot', $botSecret)
   $botToken = $botCredential.GetNetworkCredential().Password
   $botUpdates = Invoke-RestMethod -Uri "https://api.telegram.org/bot$botToken/getUpdates"
   $botUpdates.result | ForEach-Object { if ($_.message.chat.type -eq 'private') { "chat=$($_.message.chat.id) user=$($_.message.from.id)" } }
   Remove-Variable botToken, botSecret, botCredential, botUpdates
   ```

   Use the IDs from **your own** private message. If no update appears, send another message to the bot and retry. Do not run this while Pi is polling. If a webhook is configured, remove it using the Bot API after coordinating with its owner; `getUpdates` and webhooks cannot be used together.
3. Set environment variables in the shell that launches Pi (the example placeholders are not credentials). The extension never automatically loads `.env` files:

   ```powershell
   $env:PI_TELEGRAM_BOT_TOKEN = Read-Host 'Bot token'
   $env:PI_TELEGRAM_CHAT_ID = 'YOUR_PRIVATE_CHAT_ID'
   $env:PI_TELEGRAM_USER_ID = 'YOUR_USER_ID'
   $env:PI_TELEGRAM_TIMEOUT_SECONDS = '3600'
   $env:PI_TELEGRAM_POLL_TIMEOUT_SECONDS = '30'
   ```

   For the token, prefer a secret manager or the masked prompt above when practical; ordinary environment variables are visible to the process and potentially to other processes under the same account. Timeout is 1–86400 seconds; poll timeout is 1–50 seconds. Invalid or missing configuration is reported on session start and tool calls fail promptly. Restart Pi after changing the environment.
4. Install dependencies in this directory with `npm ci`. For an isolated trial that does not change Pi settings and avoids the original tool conflict, run:

   ```powershell
   pi --no-extensions -e 'G:\Projects\pi-ask-user-telegram\src\index.ts'
   ```

   `--no-extensions` disables discovery of other extensions for that invocation; explicitly add any others you need with `-e`. In Pi, `/telegram-status` reports configuration, polling, last successful connectivity and pending count without exposing the token. Trigger `ask_user` through an agent request to test an actual interaction.
5. For a persistent local installation, first disable the original `pi-ask-user` extension resource using `pi config` (check both personal and project scopes), and check for any other `ask_user` registrations. Then run `pi install 'G:\Projects\pi-ask-user-telegram'` and restart Pi or `/reload`. `pi install` changes Pi settings; it is not run automatically by this project. `pi list` and `pi config` show installed resources. The original package's bundled skill is separate; choose whether to keep it enabled.

Pi 1.4.0 reports duplicate tool registrations as diagnostics but leaves extensions loaded; the **first** registered definition wins. Do not depend on loading order. Disable every other `ask_user` implementation before persistent use. No files in the original package need to be edited.

To roll back, run `pi remove 'G:\Projects\pi-ask-user-telegram'`, re-enable the original resource in `pi config`, and restart or `/reload`. If the original package was removed, reinstall it with `pi install npm:pi-ask-user`. A one-off `--no-extensions -e ...` trial needs no uninstall.

## Interaction and compatibility

The model-facing tool name, description, prompt guidance and TypeBox parameter schema match `pi-ask-user` 0.17.1. It accepts `question` or 2–4 independent `questions`, per-question `context`, `options` (`{title, description?}` in the schema; strings and common aliases are also normalized at runtime), `allowMultiple`, `allowFreeform`, `allowComment`, and the reference's display and timeout parameters. `allowMultiple` defaults to false, `allowFreeform` to true, and `allowComment` follows the same parameter, `PI_ASK_USER_ALLOW_COMMENT`, `ask-user.json`, false precedence. `PI_CODING_AGENT_DIR` controls the settings directory. UI-only display, layout, and shortcut settings have no effect on Telegram.

Tap a single option to select it. Multi-select toggles options and requires **Confirm selection**, with at least one selected. Tap **Type custom response** to answer freely when allowed. With no options, reply with text even if `allowFreeform` is false, matching the reference. Replies must use Telegram's reply action on the corresponding question message; unrelated messages are ignored. Empty free-text replies are ignored. When comments are enabled, reply with a comment after selecting, or tap **Continue without comment**. Each batch question is sent in order and can be skipped; unlike the reference's interactive review screen, Telegram does not provide a batch review or revision page. Cancel cancels the entire batch. Selection titles, trimmed free text and optional comments are returned in the reference's `content` and `details` shapes; skip entries are index aligned. The reference's pre-aborted `Cancelled` result is also preserved.

The per-call `timeout` is in milliseconds; a positive value is capped by the configured Telegram timeout. A batch has one deadline. Cancel, timeout, Pi abort, reload, session shutdown, and terminal polling failure resolve pending requests as the reference's cancelled result, never as an invented answer. A failed send throws a tool error. Network interruptions and server errors retry indefinitely with bounded exponential backoff; rate limits honor Telegram's retry delay and the question deadline continues to run. Telegram API error 401/404 suggests an invalid token, 403 usually means the bot cannot message the configured chat (start the bot), 409 indicates a webhook or another poller, and 429 is rate limiting. Permanent polling errors stop the transport, release the local lock, and are reported once and by `/telegram-status`; they are not automatically restarted. A later session start revalidates configuration and attempts a fresh transport.

The extension emits the reference's `herdr:blocked`, `ask:answered`, and `ask:cancelled` events. Answer payloads are redacted by default; the reference's `PI_ASK_USER_EMIT_FULL_EVENTS` or `emitFullEvents` setting opts in to broadcasting complete answer data to other extensions. A sequential Telegram batch has no live review page, original terminal/Tern rendering, or `onUpdate` presentation. Pi terminal UI availability is not required. Questions over Telegram's 4096-character message limit, option titles over 100 characters, or more than 90 options fail explicitly rather than being truncated.

## Shared interaction service

The extension also exposes a versioned programmatic service for other Pi extensions on Pi's process-wide extension event bus. Consumers emit `pi-ask-user-telegram:interaction-service:v1` with protocol version 1 and an `accept(service)` callback; the lifecycle-owned service is returned synchronously. Public TypeScript request, response, option, discovery, and service types plus the channel/version constants are exported from the package root and `src/service.ts`.

The service is not a second client: it multiplexes requests through the same `Transport`, polling loop, chat/sender authentication, token lock, pending map, cancellation controller, and shutdown lifecycle used by `ask_user`. Requests carry caller-supplied unique IDs and stable internal option IDs. Responses repeat the request ID and return option IDs rather than deriving authorization from button labels. Consumers remain responsible for validating those IDs and applying domain policy; Telegram callbacks never execute consumer actions.

Programmatic requests can include complete `details`. The initial keyboard exposes only **View details** and **Cancel** until all numbered detail messages have been sent successfully; decision controls become active afterward. A detail delivery failure rejects the request and accepts no decision. Completed and cancelled controls are invalidated best-effort, while the pending-map removal remains authoritative. A zero `timeoutMs` means no interaction timeout, allowing a consumer to preserve its own waiting semantics; abort, shutdown, transport failure, or failed initial delivery still settles the request. Permanent transport failure rejects programmatic requests so consumers can distinguish outage from user cancellation. Ordinary model-facing `ask_user` retains its established cancelled-result compatibility.

This API intentionally uses Pi's documented event bus rather than a package-global singleton or import-path identity. It therefore remains one service even when consumer extensions do not share a package-local module instance. If the provider extension is absent or its protocol is incompatible, discovery returns no service and consumers should fail closed rather than instantiate another poller.

## Security, concurrency and recovery

Only messages and callbacks with **both** the configured private chat ID and sender ID are accepted. Buttons carry random opaque IDs, and text is matched by reply-to-message ID. Concurrent tool calls in one process are independent. The bot token is used only for HTTPS requests and never intentionally included in errors, tool results or session events. Telegram and anyone with access to the authorized account or the host can see the question and answer. Answers are returned to Pi and therefore may be stored in Pi session history; do not use this for secrets. Telegram messages remain in chat history. Completion updates retain the question and context, include selected option titles when they fit, and do not repeat free-text answers or comments. Controls are removed on a best-effort basis.

Only one `getUpdates` consumer may use a bot token. A local atomic lock prevents competing instances using the same OS temporary directory; it cannot coordinate separate hosts, containers, users with different temporary directories, or unrelated Telegram clients. Use separate bot tokens per process, or a future centralized dispatcher. Telegram can report conflicts as 409. Shutdown releases the lock; after a crash it can remain. The diagnostic identifies its path: verify no process uses that bot before manually removing that exact stale lock directory. No automatic stale-lock stealing is attempted.

Reload or graceful shutdown cancels in-memory questions and attempts to disable controls. A crash or restart cannot recover promises; abandoned messages may remain visible, but new processes use new random IDs and never accept their callbacks or replay old answers. Network failures cannot outlive the configured question deadline. Edits and callback acknowledgements are best effort; if an edit fails, stale controls remain harmless. There is no durable pending-question storage or automatic webhook management.

## Development

`npm run build`, `npm run test`, and `npm run check` type-check and run mocked tests without Telegram credentials or real messages. `build` is a TypeScript check because Pi loads the TypeScript extension directly. The reference schema and description in `src/schema.ts` are derived from `pi-ask-user` 0.17.1 under its MIT license; see LICENSE.
