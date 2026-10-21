# Demo video recipe

`media/demo/` holds caldav-mcp's demo video: an AI assistant answers "What's on my list for today?"
and then moves the overdue task to tomorrow, through caldav-mcp and a demo Radicale calendar. The
exchange is real (`exchange.json`, recorded by `exchange.ts`); the clip replays it in a small chat
page (`replay.html`) with a visible pointer, then adds a title card, captions, an end card and quiet
music.

## Remake it

1. Install Deno 2, ffmpeg (with libvpx-vp9, libx264, libopus, libwebp and drawtext) and Playwright's
   Chromium: `deno run -A npm:playwright@1.63.0 install chromium`.
2. Run `deno task demo-video` from the repository root. It replays the committed `exchange.json`,
   records it (`record.ts`, about a minute) into `media/demo/.take/`, writes
   `media/demo/captions.vtt`, and encodes `demo.webm`, `demo.mp4`, `poster.webp` and
   `poster-640.webp` (`encode-demo.ts`, a few minutes). Nothing calls an AI model.
3. To change a caption's words or the music without recording again, edit `media/demo/captions.vtt`
   (or replace `music.opus` and `MUSIC.md`) and run `deno task demo-video:encode`. It re-encodes the
   last take in `media/demo/.take/`, which is gitignored. A new recording rewrites `captions.vtt`
   from the `CAPTIONS` list in `record.ts`, so put lasting wording changes there.
4. For a new real exchange (after a change to the tools, or new questions in `exchange.ts`), run
   `deno task demo-video -- --live`. It also needs Docker and Claude Code (`claude`). It starts a
   throwaway Radicale on a loopback port, seeds made-up tasks dated around today (`seed.ts`), runs
   the two questions through `claude -p` with this checkout's `main.ts` as its only MCP server, with
   no user settings, hooks or built-in tools, and replaces `exchange.json`. The container and its
   volume are removed when the script ends. It never touches a real calendar.
5. Check the result before committing: a contact sheet
   (`ffmpeg -i media/demo/demo.mp4 -vf "fps=1,scale=320:-1,tile=6x9" -frames:v 1 sheet.png`), 30 fps
   and an audio stream in both files, about -28 LUFS.

## Files

- `record.ts`: the browser recording, from Chrome's screencast frames, each held for as long as it
  was on screen, so a busy machine sends fewer frames but never changes the pace. It also times the
  captions by the replay's steps.
- `replay.html`: the chat page. It is drawn at 1.5x so its text stays readable where sites play the
  clip about 528 px wide, and it keeps the bottom 84 px free for the captions.
- `encode-demo.ts` and `encode.ts`: the encoder from the `demo-video` skill (cards, captions, music
  at -28 LUFS, a refusal for unreadable captions or a loud mix).
- `pointer.js`, `human-mouse.ts`: the drawn pointer and the human-paced mouse, from the same skill.
- `fonts/`: IBM Plex Sans and Mono for the page (SIL Open Font License, `LICENSE-ibm-plex.txt`).
- `deno.jsonc`: the recipe's own config, so Playwright stays out of the server's dependencies.
