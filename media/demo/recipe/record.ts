/**
 * Records the demo video's raw take: replays `exchange.json` (the real exchange from exchange.ts)
 * in `replay.html` at 1280x800, typing each question into the composer with a visible pointer.
 *
 * Frames come from Chrome's screencast (CDP `Page.startScreencast`), each stamped with the time
 * Chrome painted it, so a loaded machine sends fewer frames but never changes the pace: the
 * concat list holds each frame for exactly as long as it was on screen. It writes, into `<take>`:
 * `frames/*.jpg`, `frames.txt` (the concat list `encode-demo.ts` reads) and `poster.png` (the
 * opening screen without the pointer). It also writes `media/demo/captions.vtt`, timing each
 * caption by the step of the replay it describes.
 *
 *   deno run -A --config media/demo/recipe/deno.jsonc media/demo/recipe/record.ts <take dir>
 */
import { chromium } from 'playwright'
import { CARD_SECONDS } from './encode.ts'
import { clickLike, moveLike, type Point, typeLike } from './human-mouse.ts'

const W = 1280
const H = 800
/** Device pixels per CSS pixel: the screencast sends 2560x1600, so text stays sharp at 1280. */
const SCALE = 2
/** Where the pointer waits while a turn plays: the right margin, beside the column. */
const PARK: Point = { x: 1262, y: 300 }

/**
 * Each caption starts at a step of the replay and lasts until the next one; the last lasts until
 * the take ends. `ask-<n>` is when the pointer heads for the composer, `thinking-<n>` when the
 * question is sent, `answer-<n>` when the answer starts (both from replay.html).
 */
const CAPTIONS: [step: string, text: string][] = [
  ['start', 'An AI assistant with caldav-mcp and a demo calendar'],
  ['ask-0', `Ask what is on today's list`],
  ['thinking-0', 'It asks caldav-mcp for the events and tasks'],
  ['answer-0', 'One meeting and four tasks today, one of them overdue'],
  ['ask-1', 'Ask it to move the overdue task to tomorrow'],
  ['thinking-1', 'caldav-mcp saves the new due date on the server'],
  ['answer-1', 'Done: the task is due tomorrow at the same time'],
]

const here = new URL('.', import.meta.url).pathname
if (!Deno.args[0]) throw new Error('usage: record.ts <take dir>')
const exchange = JSON.parse(await Deno.readTextFile(`${here}exchange.json`))
await Deno.remove(`${Deno.args[0]}/frames`, { recursive: true }).catch(() => {})
await Deno.mkdir(`${Deno.args[0]}/frames`, { recursive: true })
// Absolute, because the concat list's paths are read relative to the list itself.
const take = await Deno.realPath(Deno.args[0])

/** One screencast frame: its file and when Chrome painted it, in seconds since the epoch. */
interface Frame {
  file: string
  at: number
}

const frames: Frame[] = []
const writes: Promise<void>[] = []
const marks = new Map<string, number>()
const now = () => Date.now() / 1000
let latest: string | null = null
let recording = false

const browser = await chromium.launch()
let start = 0
let end = 0
try {
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: SCALE,
    colorScheme: 'dark',
    timezoneId: 'UTC',
    locale: 'en-GB',
  })
  try {
    const pointer: Point = { x: 900, y: 520 }
    await context.addInitScript(
      `window.__demoPointerOptions = ${JSON.stringify(pointer)};` +
        `window.__exchange = ${JSON.stringify(exchange)};`,
    )
    await context.addInitScript({ path: `${here}pointer.js` })
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`page error: ${e.message}`))
    await page.goto(`file://${here}replay.html`)
    await page.evaluate('document.fonts.ready')
    await page.mouse.move(pointer.x, pointer.y)
    await page.evaluate(`__demoPointerVisible(false)`)
    await page.screenshot({ path: `${take}/poster.png` })
    await page.evaluate(`__demoPointerVisible(true)`)

    const cdp = await context.newCDPSession(page)
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      latest = data
      if (recording) {
        // Pushed in arrival order before the write, so a slow write never reorders frames.
        const file = `${take}/frames/${String(frames.length).padStart(6, '0')}.jpg`
        frames.push({ file, at: metadata.timestamp ?? now() })
        writes.push(Deno.writeFile(file, decode(data)))
      }
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
    })
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 90,
      maxWidth: W * SCALE,
      maxHeight: H * SCALE,
      everyNthFrame: 1,
    })
    // A still page paints once; wait for that frame, then start with what the screen shows.
    for (let i = 0; !latest && i < 100; i++) await page.waitForTimeout(50)
    if (!latest) throw new Error('the screencast sent no frame')
    start = now()
    const first = `${take}/frames/${'0'.padStart(6, '0')}.jpg`
    frames.push({ file: first, at: start })
    writes.push(Deno.writeFile(first, decode(latest)))
    recording = true
    marks.set('start', start)

    // The empty chat with the connected server, held so its caption can be read.
    await page.waitForTimeout(3800)
    const field = page.locator('#msg')
    const send = page.locator('#send')
    for (let i = 0; i < exchange.turns.length; i++) {
      marks.set(`ask-${i}`, now())
      await typeLike(page, pointer, field, exchange.turns[i].question)
      await page.waitForTimeout(500)
      await clickLike(page, pointer, send)
      // Off the column, so the pointer covers nothing while the turn plays.
      await moveLike(page, pointer, PARK)
      await page.waitForFunction(
        (n) => (globalThis as unknown as { __turnDone: number }).__turnDone >= n,
        i,
        { timeout: 120_000 },
      )
      await page.waitForTimeout(i === exchange.turns.length - 1 ? 4500 : 3000)
    }
    end = now()
    recording = false
    await cdp.send('Page.stopScreencast')
    const steps = await page.evaluate(() =>
      (globalThis as unknown as { __marks: { name: string; at: number }[] }).__marks
    )
    for (const step of steps) marks.set(step.name, step.at / 1000)
  } finally {
    await context.close()
  }
} finally {
  await browser.close()
}
await Promise.all(writes)

// Each frame lasts until the next one. The concat demuxer times still images in steps of 1/25 s
// and pushes a shorter frame to the next step, which made the take seconds longer than the
// recording; so each frame is placed on that grid, and of two in one step the later one wins.
// The demuxer ignores the last entry's duration, so the last file is listed once more.
const GRID = 25
const slots = new Map<number, string>()
for (const frame of frames) {
  slots.set(Math.max(0, Math.round((frame.at - start) * GRID)), frame.file)
}
const last = Math.round((end - start) * GRID)
const kept = [...slots].filter(([slot]) => slot < last).sort(([a], [b]) => a - b)
const lines: string[] = []
kept.forEach(([slot, file], i) => {
  const next = kept[i + 1]?.[0] ?? last
  lines.push(`file '${file}'`, `duration ${((next - slot) / GRID).toFixed(2)}`)
})
lines.push(`file '${kept.at(-1)![1]}'`)
await Deno.writeTextFile(`${take}/frames.txt`, lines.join('\n') + '\n')

const stamp = (s: number) => {
  const ms = Math.round(s * 1000)
  const mm = String(Math.floor(ms / 60_000)).padStart(2, '0')
  const ss = String(Math.floor(ms / 1000) % 60).padStart(2, '0')
  return `${mm}:${ss}.${String(ms % 1000).padStart(3, '0')}`
}
const times = CAPTIONS.map(([step]) => {
  const t = marks.get(step)
  if (t === undefined) throw new Error(`the replay never reached the step "${step}"`)
  return CARD_SECONDS.title + t - start
})
const cues = CAPTIONS.map(([, text], i) =>
  `${stamp(times[i]!)} --> ${stamp(times[i + 1] ?? CARD_SECONDS.title + last / GRID)}\n${text}`
)
await Deno.writeTextFile(`${here}../captions.vtt`, `WEBVTT\n\n${cues.join('\n\n')}\n`)
console.log(
  `recorded ${frames.length} frames over ${(end - start).toFixed(1)} s into ${take}/frames.txt`,
)

/** A base64 screencast frame as bytes. */
function decode(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
}
