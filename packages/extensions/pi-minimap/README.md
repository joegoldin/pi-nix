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

Routine updates need five new message/tool-result records and wait at least
30 seconds between requests by default. Questions, agent completion, goal actions
and reported failures can flush a smaller batch, still respecting that interval.
There is one request in flight and no idle polling for summaries. Output is capped
at 600 tokens.

Normal input contains at most eight 240-character excerpts, current focus and the
small recent list. Reopening uses one catch-up request with at most twelve
480-character excerpts and an explicit omitted-event count. Opening unchanged
history makes no request. Routine updates omit archived history; folding refers to
recent entries by index, and older compaction uses existing summaries, not another
copy of raw events. A recap can revise entries and remove redundant chatter.

Thinking, images and argument bodies are excluded. Bounded text from tool output
already in the main transcript is included, retaining useful headers/result tails.
Target paths and task labels are retained; common credential forms are redacted
before clipping. This text goes to the selected provider when the panel is open.
Redaction is not a guarantee that arbitrary private text can safely be shared.

History is bounded to six recent entries, two milestones and up to three short
EARLIER bullets. Empty model beats do not produce tool-call spam. Entries can be
revised rather than appended; exact repeats are merged. Source IDs link back to the
original transcript. Branch-local snapshots use Pi's append-only custom-entry
persistence; they are not model-context messages.

The bottom usage display counts only minimap calls, across model and branch switches
within the same session. A fork inherits history, not its parent's spend ledger. Input
includes cache reads/writes; output uses provider-reported output tokens. Prices
are estimates, always shown to four decimal places, not an invoice. For direct
Cerebras endpoints, the extension asks `/v1/models?format=openrouter` for current
per-token rates. Successful results are cached for one hour; failed lookups back
off for five minutes and fall back to the configured model prices. Metadata fetches
have a three-second timeout and do not count as inference calls. Credentials are
never forwarded from custom endpoints, and redirects are rejected. OpenAI's model
API does not publish rates, so Luna uses configured/catalog prices. No account
billing endpoint is queried. Missing cache-token rates remain unknown when those
tokens were used.

Missing pricing displays **cost unavailable**; partly reported totals have **+ ?**.
Cancelled or invalid replies still count when usage is reported. A call whose usage
was not returned remains explicitly unreported, including an interrupted call
restored after restart.

The sidebar extends alongside todos and other above-editor widgets, ending just
above the full-width editor. Event ages use source timestamps when known (for
example, “8m ago”); legacy unknown times stay blank. A local minute tick refreshes
ages without inference. The compact key distinguishes asks, decisions, changes,
checks and issues; success/error colors take precedence.

“Now” is model-written purpose: up to two parent topics and one subtopic level,
with at most four displayed lines. Parent goals stay stable while current steps
change. The runtime status is separate: active agent,
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
