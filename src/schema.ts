import { Type } from "@sinclair/typebox";
const BATCH_MIN_QUESTIONS = 2, BATCH_MAX_QUESTIONS = 4;
const StringEnum = (values: readonly string[], options: { description: string }) => Type.Unsafe<string>({ type: "string", enum: [...values], ...options });
   // runtime for older transcripts. See issue #22.
   const optionSchema = Type.Object({
      title: Type.String({ description: "Short title for this option" }),
      description: Type.Optional(
         Type.String({ description: "Longer description explaining this option" }),
      ),
   });

export const definition = {
      exposure: "model-only" as const,
      name: "ask_user",
      label: "Ask User",
      description:
         "Ask the user a question with optional multiple-choice answers. Use this to gather information interactively. Ask one focused question per call, or 2-4 independent questions together through questions. Before calling, gather context with tools (read/web/ref) and pass a short summary via the context field.",
      promptSnippet:
         "Ask the user one focused question (or 2-4 independent ones together) with optional multiple-choice answers to gather information interactively",
      promptGuidelines: [
         "Before calling ask_user, gather context with tools (read/web/ref) and pass a short summary via the context field.",
         "Use ask_user when the user's intent is ambiguous, when a decision requires explicit user input, or when multiple valid options exist.",
         "Ask one focused question per ask_user call by default.",
         "Use questions (2-4 entries) only for independent decisions whose prerequisites are already settled; ask anything that depends on another answer in a later ask_user call.",
         "With questions, put every question inside questions. A top-level question is only shown as the batch heading and is never asked or answered.",
         "Do not combine multiple numbered, multipart, or unrelated questions into one question's text.",
      ],
      // Block other tool calls in the same assistant turn until the user answers,
      // so the model can't batch ask_user with bash/edit/write and let those run
      // (potentially with side effects) before the user sees the prompt.
      executionMode: "sequential" as const,
      parameters: Type.Object({
         question: Type.Optional(
            Type.String({ description: "The question to ask the user. With questions, it is only an optional heading for the batch; put every actual question inside questions." }),
         ),
         questions: Type.Optional(
            Type.Array(
               Type.Object({
                  question: Type.String({ description: "One question in the batch" }),
                  context: Type.Optional(
                     Type.String({ description: "Relevant context to show with this question (summary of findings)" }),
                  ),
                  options: Type.Optional(
                     Type.Array(optionSchema, { description: "List of options for this question" }),
                  ),
                  allowMultiple: Type.Optional(
                     Type.Boolean({ description: "Allow selecting multiple options. Default: false" }),
                  ),
                  allowFreeform: Type.Optional(
                     Type.Boolean({ description: "Add a freeform text option. Default: true" }),
                  ),
               }),
               {
                  minItems: BATCH_MIN_QUESTIONS,
                  maxItems: BATCH_MAX_QUESTIONS,
                  description: "2-4 independent questions shown together, used instead of question. Set context, options, allowMultiple, and allowFreeform on each entry; the remaining parameters apply to the whole batch.",
               },
            ),
         ),
         context: Type.Optional(
            Type.String({
               description: "Relevant context to show before the question (summary of findings)",
            }),
         ),
         options: Type.Optional(
            Type.Array(optionSchema, { description: "List of options for the user to choose from" }),
         ),
         allowMultiple: Type.Optional(
            Type.Boolean({ description: "Allow selecting multiple options. Default: false" }),
         ),
         allowFreeform: Type.Optional(
            Type.Boolean({ description: "Add a freeform text option. Default: true" }),
         ),
         allowComment: Type.Optional(
            Type.Boolean({ description: "Collect an optional comment after selecting one or more options. Default: PI_ASK_USER_ALLOW_COMMENT env var or allowComment in ~/.pi/agent/ask-user.json (respecting PI_CODING_AGENT_DIR) if set, otherwise false." }),
         ),
         displayMode: Type.Optional(
            StringEnum(["overlay", "inline"] as const, {
               description: "UI rendering mode. 'overlay' shows a centered modal, 'inline' renders in-place. Default: PI_ASK_USER_DISPLAY_MODE env var, then displayMode in ~/.pi/agent/ask-user.json (respecting PI_CODING_AGENT_DIR), otherwise 'overlay'. Omit to respect the user's configured preference.",
            }),
         ),
         singleSelectLayout: Type.Optional(
            StringEnum(["auto", "list"] as const, {
               description: "Single-select layout. 'auto' uses a details pane on wide terminals; 'list' always keeps descriptions below options. Default: PI_ASK_USER_SINGLE_SELECT_LAYOUT env var, then singleSelectLayout in ~/.pi/agent/ask-user.json (respecting PI_CODING_AGENT_DIR), otherwise 'auto'.",
            }),
         ),
         contextExpanded: Type.Optional(
            Type.Boolean({
               description: "Start with oversized context expanded instead of collapsed behind a one-line summary. Default: PI_ASK_USER_CONTEXT_EXPANDED env var or contextExpanded in ~/.pi/agent/ask-user.json (respecting PI_CODING_AGENT_DIR) if set, otherwise false.",
            }),
         ),
         overlayToggleKey: Type.Optional(
            Type.String({
               description:
                  "Shortcut for hiding/showing the overlay popup (overlay mode only), e.g. 'alt+o' or 'ctrl+shift+h'. Pass 'off' to disable. Default: PI_ASK_USER_OVERLAY_TOGGLE_KEY env var, then overlayToggleKey in ~/.pi/agent/ask-user.json (respecting PI_CODING_AGENT_DIR), otherwise 'alt+o'.",
            }),
         ),
         commentToggleKey: Type.Optional(
            Type.String({
               description:
                  "Shortcut for toggling the optional comment/extra-context row when allowComment is true, e.g. 'ctrl+g'. Pass 'off' to disable. Default: PI_ASK_USER_COMMENT_TOGGLE_KEY env var, then commentToggleKey in ~/.pi/agent/ask-user.json (respecting PI_CODING_AGENT_DIR), otherwise 'ctrl+g'.",
            }),
         ),
         timeout: Type.Optional(
            Type.Number({ description: "Auto-dismiss after N milliseconds. Returns null (cancelled) when expired." }),
         ),
      }),
};
