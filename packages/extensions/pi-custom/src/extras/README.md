# extras: prompt and session handling

Entry: `index.ts`. Only the terminal UI has an editor, a title and raw input,
so each feature checks for its surface and is skipped where it is missing.
There is no footer here; the status line belongs to another extension.

## Keys

| Key | Action |
|---|---|
| ctrl+s | Stash the prompt, or bring the last stash back when the prompt is empty |
| ctrl+g s / u / U | Stash, unstash, unstash all |
| ctrl+g l | Open the stash list (restore, copy, delete, clear) |
| ctrl+g c / x | Copy or cut the prompt to the system clipboard |
| alt+i | Insert a literal tab |
| Esc (with messages queued) | Interrupt and send the queued messages now; your draft stays in the editor. Auto mode treats it as an interruption, not a refusal: a check it was making on the interrupted call is not recorded as a denial. A plain Esc still cancels |
| ctrl+? | Show these keys |

While a ctrl+g chord is half-typed, a hint above the editor names the second
keys.

## Commands

- `/exit` (and `/e`): exit pi.
- `/clear`: start a new session.
- `/clone-session`: copy this session into a new one, leaving the original.
- `/stash`: open the stash list.

## Also

- **Tab title.** Shows a working indicator while the agent runs and restores
  pi's title when it stops.
- **Git editor.** Sets `GIT_EDITOR` and `GIT_SEQUENCE_EDITOR` (unless already
  set) so `git commit` without `-m` or `git rebase -i` can't hang a tool call
  waiting on an editor. `PI_CUSTOM_GIT_EDITOR` picks the command.
- **Clipboard.** `PI_CUSTOM_CLIPBOARD` overrides the wl-copy, xclip,
  pbcopy chain; with none available, copy and cut are simply unavailable.

## Files

| File | Role |
|---|---|
| `index.ts` | Registration, chord dispatch, commands |
| `chord.ts` | Raw-input chord reader (ctrl+g prefix, ctrl+s, alt+i, ctrl+?) |
| `hint.ts` | The half-typed chord hint |
| `shortcuts.ts` | The ctrl+? panel |
| `stash.ts` | Stash list and its persistence |
| `filter.ts` | Filtering and windowing for the stash list (pure) |
| `overlay.ts` | The stash list view |
| `input.ts` | Prompt text transforms |
| `clipboard.ts` | Clipboard command resolution |
| `gitenv.ts` | Git editor overrides |
| `title.ts` | The working tab title |
| `steer.ts` | Esc with messages queued: interrupt and send them |
