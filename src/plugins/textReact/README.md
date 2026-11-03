# TextReact

React to a message with text instead of adding regional indicator emojis one by one.

## Opening it

- **Hold a modifier and click the Add Reaction button** in a message's hover toolbar. Instead of the emoji picker, the text reaction dialog opens.
- Or right click a message → **React with Text**.

Type what you want to say, check the preview and hit **Add Reactions**. Every letter is turned into its regional indicator emoji, so `hi there` becomes `🇭🇮 ⬜ 🇹🇭🇪🇷🇪`. Punctuation gets its emoji too: `Why?!` becomes `🇼🇭🇾 ⁉️`, `Why!!` becomes `🇼🇭🇾 ‼️` and `Why??` becomes `🇼🇭🇾 ❓ ❔`.

## What maps to what

| Input | Reaction |
| --- | --- |
| `a` - `z` (any case) | Regional indicator emojis 🇦 - 🇿 |
| `0` - `9` | Keycaps 0️⃣ - 9️⃣ |
| `?` | ❓, the next one ❔ |
| `!` | ❗, the next one ❕ |
| `?!` / `!?` | ⁉️ |
| `!!` | ‼️ |
| `!!!` and longer | ‼️, then ❗ and ❕ |
| space | Your configured word spacer (default ⬜) |
| anything else | Ignored |

Repeats escalate instead of being thrown away, so `Why? Why! Why? Why!` becomes 🇼🇭🇾 ❓ ❗ ❔ ❕ — the second `?` is the grey ❔ and the second `!` the grey ❕.

## Settings

- **Word Spacer** — the emoji used for spaces. Leave it empty to ignore spaces entirely.
- **Modifier** — which key has to be held when clicking Add Reaction: any of Ctrl/Shift/Alt (default), or one specific key.

## Limitations

- Discord does not allow the same reaction twice on one message, so repeated letters collapse: `hello` reacts with 🇭🇪🇱🇴. Repeated `?` and `!` get one extra chance as their grey variant, and anything past that is dropped (a third `?`, or the second `?!`). The preview in the dialog always shows exactly what will be added.
- Discord allows at most 20 distinct reactions per message. If your text is longer than that, only the first 20 are added and you get a warning toast.
- Reactions are added one at a time, ~120-210 ms apart, so a long word does not trip Discord's reaction rate limit. A full 20 characters takes a couple of seconds to appear.
- The modifier click is matched against Discord's hover toolbar markup (a dialog popout button inside the message utilities toolbar), not a minified component patch. If Discord reshuffles that markup, the shortcut stops triggering instead of breaking anything; right click → React with Text always works. Enable Vencord's debug logging to see what the plugin found on a modifier click.
