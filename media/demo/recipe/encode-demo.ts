/**
 * Encodes the last raw take into media/demo/: the title and end cards, the captions from
 * `captions.vtt`, the music from `music.opus`, then `demo.webm`, `demo.mp4` and the posters.
 * Runs alone after a caption or music change; no new recording needed.
 *
 *   deno run -A --config media/demo/recipe/deno.jsonc media/demo/recipe/encode-demo.ts [take dir]
 */
import { encodeDemo } from './encode.ts'

const here = new URL('.', import.meta.url).pathname
const take = Deno.args[0] ?? `${here}../.take`

await encodeDemo({
  take: `${take}/frames.txt`,
  out: `${here}..`,
  title: 'caldav-mcp',
  // The README's first line, shortened to fit one line of the card.
  claim: 'Let your AI assistant manage your CalDAV calendar and tasks',
  end: 'github.com/spy4x/caldav-mcp',
  poster: `${take}/poster.png`,
})
