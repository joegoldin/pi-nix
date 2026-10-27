# pi-minimap

A source-linked semantic sidebar for fullscreen Pi. It observes the conversation;
it cannot run tools, edit files, steer the agent or inject chat messages.

Enable the package with `programs.pi.coding-agent.minimap.enable = true`, then use
`/minimap` to open it. Loading the extension does not start inference. Its visible
state and selected model are restored from the current session branch.

## Controls

- `/minimap [on|off|model|refresh]` toggles the panel, switches the summarizer or
  retries a failed update.
- **Ctrl+M** toggles and **Ctrl+Shift+M** switches models when the terminal sends
  distinct Kitty key encodings. Ordinary Enter is never intercepted: legacy
  terminals encode Ctrl+M as Enter. **Alt+m / Alt+Shift+m** are safe fallbacks.
  These shortcuts run only at the editor, not inside protected dialogs.
- Click the model button to switch between Cerebras Qwen and OpenAI Luna with low
  reasoning. Existing summaries and usage totals survive the switch.
- Click a summary to scroll the main conversation to its source without moving
  editor focus. Milestones and recaps link to the beginning of their source span.
  A compacted-away source produces a notice rather than jumping elsewhere.
- Wheel over the panel to scroll its history independently. “Now,” runtime status,
  and minimap-only token/cost totals stay pinned at the bottom. New summaries do
  not pull you away from older entries; **↓ New activity** returns to live view.

## Bounds and accounting

The default panel is 38 columns wide and hides when fewer than 72 chat columns
remain. Hiding, including automatic hiding on resize, cancels the current request
and pauses new requests. Reopening shows catching-up state and a distinct recap.

Updates coalesce over five seconds, with one request in flight. Input contains at
most twelve bounded event excerpts, compact prior state, and an explicit omitted
event count for long gaps. Thinking, images, tool argument bodies and tool outputs
are excluded. Bounded target paths and task labels are retained; common credential
forms are redacted. User and assistant text is
still sent to the selected provider when you enable the panel. Redaction is not
a guarantee that arbitrary private text can safely be shared.

History is bounded to six recent entries, two milestones and one opening
paragraph. Empty model beats do not produce tool-call spam. Summaries retain only
source IDs, not a second transcript. Branch-local snapshots use Pi's append-only
custom-entry persistence; they are not model-context messages.

The bottom usage display counts only minimap calls, across model and branch switches
within the same session. A fork inherits history, not its parent's spend ledger. Input
includes cache reads/writes; output uses provider-reported output tokens. Prices
are estimates from the runtime's reported usage and model pricing, not an invoice.
Missing pricing displays **cost unavailable**; partly reported totals have **+ ?**.
Cancelled or invalid replies still count when usage is reported. A call whose usage
was not returned remains explicitly unreported, including an interrupted call
restored after restart.

“Now” is model-written purpose. The runtime status is separate: active agent,
running tools, an open question, idle, or a confirmed goal wait/block. A tool failure
alone does not prove that the whole task is blocked. The observer never invents
runtime state from summary prose.

## Configuration

The `minimap` Nix options expose `width`, `intervalMs`, `qwenModel`, `lunaProvider`
and `lunaModel`. Defaults select the first available Cerebras Qwen model and
`openai/gpt-6-luna`. There is no fallback to another provider when one is unavailable.
Credentials come from Pi's existing registry; none are stored by this extension.

The equivalent environment variables are `PI_MINIMAP_WIDTH`,
`PI_MINIMAP_INTERVAL_MS`, `PI_MINIMAP_QWEN_MODEL`, `PI_MINIMAP_LUNA_PROVIDER` and
`PI_MINIMAP_LUNA_MODEL`. A missing Qwen ID enables registry discovery. The extension
requires this repository's generic native `setSidebar` and `scrollToSessionEntry`
hooks; RPC and ordinary scrollback mode do not mount a sidebar or spend tokens.

Tests use fake providers. They do not contact Cerebras, OpenAI or any other model
service.
