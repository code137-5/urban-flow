// Visual-verification harness — this project's test runner stand-in.
//
// CLAUDE.md: "No test runner. Verify each increment visually." This is that
// loop, committed so it stops being rewritten from scratch. It replaces eight
// ad-hoc `.shot-*.mjs` scratch scripts that each re-implemented the same
// Playwright bootstrap with one knob changed.
//
// Requires a dev server already running (`npm run dev`).
//
//   npm run shot                            # layout (default phase)
//   npm run shot -- state
//   npm run shot -- keys --flow bike
//   npm run shot -- tune --preset trend
//   npm run shot -- panels --width 1440
//
// Phases:
//   layout    toolbar + per-panel control strips across the responsive width sweep
//   overflow  clipping / text-overlap / out-of-bounds detector per width
//   state     computed CSS, theme tokens, ARIA and zoomed slider / number-input crops
//   keys      keyboard ARIA transitions on one flow's hour slider + trips-per-particle input
//   pointer   mouse press/drag/click + touch tap on the rail
//   disabled  a flow switched off disables its hour slider and trips-per-particle input
//   noblank   canvas right after an hour change — the flow blanks briefly, then refills
//   panels    grow to three panels, analyze each canvas, show the copied settings
//   perflow   moving one flow's window must not re-query the other
//   perpanel  two panels, one flow, different windows / trips per particle (bike)
//   bike      switch the bike flow on, analyze the canvas
//   volume    particle count must follow the trips in the hour window
//   tune      drive the `?tune` knobs; --preset defaults|count|scatter|ramp|trend
//
// Every per-flow control lives in each panel's strip (src/sections/PanelControls
// .tsx); helpers take a 0-based panel index `i` and query inside that panel.
// Screenshots land in .preview/ (gitignored). Every phase prints JSON to stdout;
// `ASSERT … FAIL` lines set a non-zero exit code.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/* ---------------------------------------------------------------- options */

const PHASES = ['layout', 'overflow', 'state', 'keys', 'pointer', 'disabled', 'noblank', 'panels', 'perflow', 'perpanel', 'bike', 'volume', 'tune']

const argv = process.argv.slice(2)
const phase = argv.find((a) => !a.startsWith('-')) ?? 'layout'
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}

if (!PHASES.includes(phase)) {
  console.error(`unknown phase '${phase}'\nphases: ${PHASES.join(' ')}`)
  process.exit(2)
}

const OUT = path.resolve('.preview')
const BASE_URL = process.env.SHOT_URL ?? 'http://localhost:5173/'
// SwiftShader: headless Chromium has no GPU, and the terrain/particle layers
// need a real WebGL2 context or every canvas comes back empty.
const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
// The grid's column breakpoints (Dashboard.tsx columnCapForWidth: ≤672 → 1,
// ≤1056 → 2, else 3) plus the phone and a wide desktop.
const WIDTHS = (opt('width') ? [Number(opt('width'))] : [360, 672, 1056, 1312, 1440])
const FLOW = opt('flow', 'migration')

const log = (...a) => console.log(...a)
const J = (o) => JSON.stringify(o)

/** A named check: logged either way; a failure makes the run exit non-zero. */
function assert(name, ok, detail) {
  log(`ASSERT ${name}: ${ok ? 'PASS' : 'FAIL'}`, detail === undefined ? '' : J(detail))
  if (!ok) process.exitCode = 1
  return ok
}

/* ------------------------------------------- PNG -> RGBA, for canvas stats */

/** Playwright writes 8-bit RGB/RGBA, non-interlaced — that is all this handles. */
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0, bd = 0
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    p += 12 + len
  }
  if (bd !== 8 || (ct !== 6 && ct !== 2)) throw new Error(`unsupported png ct=${ct} bd=${bd}`)
  const ch = ct === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(w * h * 4)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride))
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0
      if (f === 1) line[x] = (line[x] + a) & 255
      else if (f === 2) line[x] = (line[x] + b) & 255
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c)
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
    }
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 4] = line[x * ch]
      out[(y * w + x) * 4 + 1] = line[x * ch + 1]
      out[(y * w + x) * 4 + 2] = line[x * ch + 2]
      out[(y * w + x) * 4 + 3] = ch === 4 ? line[x * ch + 3] : 255
    }
    prev = line
  }
  return { w, h, px: out }
}

/**
 * Pixel census of a canvas screenshot. `yellow` tracks Carbon Yellow 30
 * (#f1c21b, the living-migration particles), `bright` the near-white bike
 * particles, `nonBg` anything off the #161616 background — so "did the swarm
 * clear / refill" is a number, not an eyeball.
 *
 * `region` ({x, y, w, h} in image pixels) restricts the census to one box, so
 * several canvases can be counted from ONE page screenshot — the same frame.
 */
function analyze(file, region = null) {
  const { w: W, h: H, px } = decodePng(fs.readFileSync(file))
  const x0 = Math.max(0, Math.round(region?.x ?? 0)), y0 = Math.max(0, Math.round(region?.y ?? 0))
  const x1 = Math.min(W, Math.round(region ? region.x + region.w : W)), y1 = Math.min(H, Math.round(region ? region.y + region.h : H))
  let yellow = 0, bright = 0, nonBg = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2]
      if (r > 120 && g > 90 && b < 110 && r - b > 55 && g - b > 35) yellow++
      if (r > 200 && g > 200 && b > 200) bright++
      if (Math.abs(r - 22) > 14 || Math.abs(g - 22) > 14 || Math.abs(b - 22) > 14) nonBg++
    }
  }
  const w = x1 - x0, h = y1 - y0
  return { w, h, yellow, bright, nonBg, total: w * h }
}

/* -------------------------------------------------------------- selectors */

// CSS Modules hash every classname, hence the [class*=] matching. Names mirror
// src/sections/Dashboard.module.css, src/sections/PanelControls.module.css,
// src/ui/RangeSlider.module.css and src/ui/NumberInput.module.css.
// Note `[class*="flowRow"]` also matches the `.flowRows` strip — a single flow's
// row is the one carrying `data-flow`.
const SEL = {
  toolbar: '#dashboard div[class*="toolbar"]',
  flowRows: '#dashboard article[class*="panel"] div[class*="flowRows"]',
  panelRow: '#dashboard article[class*="panel"] div[class*="flowRow"][data-flow]',
  checks: '#dashboard article[class*="panel"] div[class*="flowRow"][data-flow] input[type=checkbox]',
  syncViews: '#dashboard label[class*="syncViews"]',
  hourHint: '#dashboard span[class*="hourHint"]',
  // The RangeSlider root carries both .root and the .hourSlider passed as
  // className, plus role="group".
  slider: '#dashboard div[class*="hourSlider"]',
  geometry: '#dashboard div[class*="hourSlider"] [class*="geometry"]',
  track: '#dashboard div[class*="hourSlider"] [class*="track"]',
  readout: '#dashboard span[class*="hourValue"]',
  // NumberInput: a text field with role=spinbutton + two −/+ stepper buttons.
  tpp: 'input[role=spinbutton]',
  stepper: 'button[class*="stepper"]',
  panel: '#dashboard article[class*="panel"]',
  canvas: '#dashboard article[class*="panel"] div[class*="canvas"]',
  addPanel: '#dashboard button[class*="addPanel"]',
  smoothing: '#dashboard input[class*="slider"]',
  bottomLeft: '#dashboard div[class*="bottomLeft"]',
}

// The `label` fields in FLOWS (src/data/odTrips.ts). Every per-flow accessible
// name in a panel strip is `Panel {n}: {label} …` (PanelControls.tsx).
const FLOW_LABEL = { bike: 'Bike trips (따릉이)', migration: 'Living migration (생활이동)' }
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The i-th (0-based) dashboard panel. */
const panelAt = (page, i) => page.locator(SEL.panel).nth(i)

/** One flow's row inside panel i. */
const rowAt = (page, i, flow) => panelAt(page, i).locator(`div[class*="flowRow"][data-flow="${flow}"]`)

/** Panel i's start/end thumb of one flow, via the aria-label PanelControls.tsx builds. */
const thumb = (page, i, flow, edge) =>
  panelAt(page, i).getByRole('slider', {
    name: new RegExp(`^Panel ${i + 1}: ${reEsc(FLOW_LABEL[flow])}.*${edge} hour$`),
  })

/** Panel i's on/off switch of one flow. */
const checkbox = (page, i, flow) => rowAt(page, i, flow).locator('input[type=checkbox]')

/** Panel i's trips-per-particle NumberInput field of one flow. */
const tpp = (page, i, flow) => rowAt(page, i, flow).locator(SEL.tpp)

/** Type a trips-per-particle value and commit it with Enter. */
async function setTpp(page, i, flow, v) {
  const t = tpp(page, i, flow)
  await t.fill(String(v))
  await t.press('Enter')
}

/* -------------------------------------------------------------- bootstrap */

/**
 * Open the dashboard and wait for it to settle. Four diagnostic channels are
 * always captured: console, uncaught errors, failed requests, and Supabase RPC
 * bodies — the last is how a phase proves which hour window was queried.
 */
async function boot(browser, { width, height = 900, hasTouch = false, scale = 1, tune = false, settle = 2500 } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    hasTouch,
  })
  const page = await ctx.newPage()
  const console_ = [], failed = [], rpc = [], pageerrors = []
  page.on('console', (m) => console_.push(`[${m.type()}] ${m.text()}`))
  // The stack, not just the message: an app bug's first frame is the lead.
  page.on('pageerror', (e) => pageerrors.push((e.stack ?? String(e)).split(/\r?\n/).slice(0, 6).join(' | ')))
  page.on('requestfailed', (r) => failed.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`))
  page.on('request', (r) => {
    if (r.url().includes('/rest/v1/rpc/')) rpc.push({ fn: r.url().split('/rpc/')[1], body: r.postData() })
  })
  await page.goto(tune ? `${BASE_URL}?tune` : BASE_URL, { waitUntil: 'load' })
  await page.locator('#dashboard').scrollIntoViewIfNeeded()
  await page.waitForTimeout(settle)
  return { ctx, page, console_, failed, rpc, pageerrors }
}

/** Click "Add a dataset" n times, letting each new panel's terrain build. */
async function addPanels(page, n, wait = 1500) {
  for (let k = 0; k < n; k++) {
    await page.locator(SEL.addPanel).click()
    await page.waitForTimeout(wait)
  }
}

/**
 * Block until a flow reports its OD reservoir, then let the swarm form.
 *
 * Supabase connect time varies by an order of magnitude (sub-second to 20 s+),
 * so a bare `waitForTimeout` silently screenshots an empty canvas and the
 * pixel counts come back near zero for no reason. Every canvas phase goes
 * through here.
 */
async function waitForSwarm(page, console_, { flow = null, form = 8000, timeout = 40000 } = {}) {
  const tag = flow ? `Supabase (${flow})` : 'Supabase ('
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (console_.some((c) => c.includes('[urban-flow]') && c.includes(tag))) {
      await page.waitForTimeout(form)
      return Math.round((Date.now() - t0) / 100) / 10
    }
    await page.waitForTimeout(250)
  }
  log(`WARN: no '${tag}' status line in ${timeout}ms — canvas may be empty or Supabase unconfigured`)
  await page.waitForTimeout(form)
  return null
}

/** Top-down 2D and optionally zoomed in, so individual trails read. */
async function flatten(page, { zoom = 0 } = {}) {
  await page.getByRole('button', { name: '2D' }).first().click().catch(() => {})
  const zoomIn = page.getByRole('button', { name: /zoom in/i }).first()
  for (let i = 0; i < zoom; i++) await zoomIn.click().catch(() => {})
}

const shot = (page, sel, name) => page.locator(sel).first().screenshot({ path: path.join(OUT, `${name}.png`) })

/** Screenshot a padded crop around an element — for the designer's eye on small chrome. */
async function crop(page, sel, name, pad = { x: 4, y: 8 }) {
  const loc = typeof sel === 'string' ? page.locator(sel).first() : sel
  await loc.scrollIntoViewIfNeeded()
  const b = await loc.boundingBox()
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    clip: { x: b.x - pad.x, y: b.y - pad.y, width: b.width + pad.x * 2, height: b.height + pad.y * 2 },
  })
}

/* ----------------------------------------------------------- ?tune knobs */

/**
 * Drive one lil-gui knob. Labels are substring-matched, so 'migration scatter'
 * finds 'migration scatter (× radius)'.
 *
 * `opacity` is the exception that needs exact + last: five folders each expose
 * an `opacity` (contours / boundary / park / river / particles, in
 * TerrainPanel.tsx's tuner) and the particle one is the last of them. Matching
 * loosely here silently retunes the contour lines instead.
 */
async function setKnob(page, label, value) {
  const gui = page.locator('.lil-gui')
  const cell = label === 'opacity'
    ? gui.getByText('opacity', { exact: true }).last()
    : gui.getByText(label, { exact: false }).first()
  const input = cell.locator('xpath=..').locator('input').first()
  await input.fill(String(value))
  await input.press('Enter')
  await input.blur()
}

/** Read knobs back by label prefix — how a phase reports the shipped defaults. */
const readKnobs = (page, labels) =>
  page.evaluate((ls) => Object.fromEntries(ls.map((l) => {
    const el = [...document.querySelectorAll('.lil-gui *')]
      .find((e) => e.children.length === 0 && e.textContent.trim().startsWith(l))
    return [l, el?.parentElement?.querySelector('input')?.value ?? null]
  })), labels)

/**
 * Every `opacity` input in DOM order: contours, boundary, park, river, particles.
 * Printed so a `tune` run proves setKnob('opacity') moved the *particle* one and
 * left the contour ramp alone — the failure this selector exists to avoid is
 * silent, since both produce a plausible-looking picture.
 */
const readOpacities = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.lil-gui *')]
    .filter((e) => e.children.length === 0 && e.textContent.trim() === 'opacity')
    .map((e) => e.parentElement?.querySelector('input')?.value ?? null))

/** ARIA snapshot of one flow's row in panel i: two thumbs, readout, switch, trips-per-particle. */
const readAria = (page, flow, i = 0) =>
  page.evaluate(({ flow, i }) => {
    const panel = document.querySelectorAll('#dashboard article[class*="panel"]')[i]
    const row = panel?.querySelector(`div[class*="flowRow"][data-flow="${flow}"]`)
    if (!row) return null
    const g = (edge) => {
      const e = [...row.querySelectorAll('[role="slider"]')]
        .find((n) => (n.getAttribute('aria-label') ?? '').endsWith(`${edge} hour`))
      if (!e) return null
      return {
        now: e.getAttribute('aria-valuenow'), min: e.getAttribute('aria-valuemin'),
        max: e.getAttribute('aria-valuemax'), text: e.getAttribute('aria-valuetext'),
        label: e.getAttribute('aria-label'), tabindex: e.getAttribute('tabindex'),
        disabled: e.getAttribute('aria-disabled'),
      }
    }
    const ro = row.querySelector('span[class*="hourValue"]')
    const root = row.querySelector('div[class*="hourSlider"]')
    const box = row.querySelector('input[type=checkbox]')
    const t = row.querySelector('input[role=spinbutton]')
    return {
      lo: g('start'), hi: g('end'),
      readout: ro?.textContent ?? null,
      // Codepoints catch an en-dash regressing to a hyphen.
      readoutCodes: ro ? [...ro.textContent].map((c) => c.codePointAt(0).toString(16)).join(' ') : null,
      rootOpacity: root ? getComputedStyle(root).opacity : null,
      rootClass: root?.className ?? null,
      on: box?.checked ?? null,
      tpp: t ? {
        value: t.value, now: t.getAttribute('aria-valuenow'), disabled: t.disabled,
        steppers: [...row.querySelectorAll('button[class*="stepper"]')].map((b) => `${b.getAttribute('aria-label')}:${b.disabled ? 'disabled' : 'enabled'}`),
      } : null,
    }
  }, { flow, i })

/**
 * Move panel i's window of one flow to [from, to) by keyboard. End thumb out to
 * 24 first, so the min-gap never blocks the start thumb on its way up.
 */
async function setWindow(page, i, flow, from, to) {
  await thumb(page, i, flow, 'end').focus()
  await page.keyboard.press('End')
  await thumb(page, i, flow, 'start').focus()
  await page.keyboard.press('Home')
  for (let k = 0; k < from; k++) await page.keyboard.press('ArrowRight')
  await thumb(page, i, flow, 'end').focus()
  for (let k = 24; k > to; k--) await page.keyboard.press('ArrowLeft')
}

/** Panel i's scale legend of one flow: its text, trips per particle and resolved particle count. */
const readScale = (page, flow, i = 0) =>
  page.evaluate(({ flow, i }) => {
    const panel = document.querySelectorAll('#dashboard article[class*="panel"]')[i]
    const e = panel?.querySelector(`div[class*="flowScale"][data-flow="${flow}"]`)
    if (!e) return null
    const t = e.querySelector('input[role=spinbutton]')
    // The field's value, not the stepper glyphs: "1 particle ≈ 15,000 trips".
    const text = [...e.childNodes]
      .map((n) => (n.nodeType === 1 && n.querySelector?.('input[role=spinbutton]') ? n.querySelector('input').value : n.textContent))
      .join(' ').replace(/\s+/g, ' ').trim()
    return {
      text,
      tpp: t ? t.value : null,
      particles: Number(e.getAttribute('data-particles')),
    }
  }, { flow, i })

/** Rail geometry of panel i's slider of one flow, in page coordinates, for pointer work. */
const railBox = (page, flow, i = 0) =>
  page.evaluate(({ flow, i }) => {
    const panel = document.querySelectorAll('#dashboard article[class*="panel"]')[i]
    const g = panel.querySelector(`div[class*="flowRow"][data-flow="${flow}"] div[class*="hourSlider"] [class*="geometry"]`)
    const b = g.getBoundingClientRect()
    return { left: b.left, top: b.top, width: b.width, height: b.height }
  }, { flow, i })

/* =========================================================== run a phase */

fs.mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ args: GL })
const noise = (c) => c.includes('urban-flow') || c.includes('error') || c.includes('Warning')

try {
  if (phase === 'layout') {
    // Grow to 3 panels by default so the multi-column widths lay out real
    // neighbours: strips must be equal height and canvases aligned per grid row.
    const add = Number(opt('add', 2))
    for (const width of WIDTHS) {
      const { ctx, page, console_, pageerrors } = await boot(browser, { width })
      await addPanels(page, add)
      const geo = await page.evaluate(() => {
        const tb = document.querySelector('#dashboard div[class*="toolbar"]')
        const r = tb.getBoundingClientRect()
        const rel = (e) => {
          if (!e) return null
          const b = e.getBoundingClientRect()
          return {
            top: Math.round(b.top - r.top), left: Math.round(b.left - r.left),
            w: Math.round(b.width), h: Math.round(b.height),
          }
        }
        const panels = [...document.querySelectorAll('#dashboard article[class*="panel"]')].map((a, idx) => {
          const strip = a.querySelector('div[class*="flowRows"]')
          const sb = strip?.getBoundingClientRect()
          const rails = [...a.querySelectorAll('div[class*="hourSlider"]')].map((e) => {
            const b = e.getBoundingClientRect()
            return { left: Math.round(b.left), right: Math.round(b.right) }
          })
          // Visual lines of the first flow row: 3 (narrow) ↔ 2 (≥520px strip).
          const first = a.querySelector('div[class*="flowRow"][data-flow]')
          let lines = 0, bottom = -Infinity
          for (const c of [...(first?.children ?? [])].map((c) => c.getBoundingClientRect()).sort((p, q) => p.top - q.top)) {
            if (c.top >= bottom - 1) { lines++; bottom = c.bottom } else bottom = Math.max(bottom, c.bottom)
          }
          const cv = a.querySelector('div[class*="canvas"]')
          return {
            n: idx + 1,
            top: Math.round(a.getBoundingClientRect().top),
            stripW: sb ? Math.round(sb.width) : null,
            stripH: sb ? Math.round(sb.height) : null,
            lines,
            // Both rails of a panel start and end at the same x despite the
            // flow labels having different widths (PanelControls grid).
            railsAligned: rails.length < 2 || rails.every((v) => v.left === rails[0].left && v.right === rails[0].right),
            rails,
            canvasTop: cv ? Math.round(cv.getBoundingClientRect().top) : null,
            readouts: [...a.querySelectorAll('span[class*="hourValue"]')].map((e) => e.textContent),
          }
        })
        const byRow = {}
        for (const p of panels) (byRow[p.top] ??= []).push(p.canvasTop)
        return {
          toolbar: { w: Math.round(r.width), h: Math.round(r.height), text: tb.innerText.replace(/\n/g, ' | ') },
          sync: rel(document.querySelector('#dashboard label[class*="syncViews"]')),
          hint: rel(document.querySelector('#dashboard span[class*="hourHint"]')),
          panels,
          stripHeightsEqual: panels.every((p) => p.stripH === panels[0].stripH),
          railsAligned: panels.every((p) => p.railsAligned),
          canvasTopsPerRow: byRow,
          canvasTopsAligned: Object.values(byRow).every((ts) => ts.every((t) => t === ts[0])),
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          sliderRoles: document.querySelectorAll('#dashboard [role=slider]').length,
          spinbuttons: document.querySelectorAll('#dashboard [role=spinbutton]').length,
        }
      })
      await shot(page, SEL.toolbar, `toolbar-${width}`)
      await crop(page, SEL.flowRows, `panelcontrols-${width}`)
      log(J({ width, geo, hscroll: geo.scrollWidth > geo.innerWidth }))
      assert(`layout@${width} strip heights equal`, geo.stripHeightsEqual, geo.panels.map((p) => p.stripH))
      assert(`layout@${width} rails aligned within each panel`, geo.railsAligned)
      assert(`layout@${width} canvas tops equal per row`, geo.canvasTopsAligned, geo.canvasTopsPerRow)
      assert(`layout@${width} no horizontal scroll`, geo.scrollWidth <= geo.innerWidth, [geo.scrollWidth, geo.innerWidth])
      log('  console:', J(console_.filter(noise)))
      if (pageerrors.length) log('  PAGEERRORS:', J(pageerrors))
      await ctx.close()
    }
  }

  if (phase === 'overflow') {
    // The toolbar and every panel's control strip, each checked against its own
    // box. 3 panels by default, so the 3-column widths test the narrowest strip.
    const add = Number(opt('add', 2))
    for (const width of WIDTHS) {
      const { ctx, page } = await boot(browser, { width })
      await addPanels(page, add)
      const r = await page.evaluate(() => {
        const containers = [
          ['toolbar', document.querySelector('#dashboard div[class*="toolbar"]')],
          ...[...document.querySelectorAll('#dashboard article[class*="panel"] div[class*="flowRows"]')]
            .map((e, k) => [`panel${k + 1}`, e]),
        ]
        const out = {}
        for (const [name, tb] of containers) {
          const els = [tb, ...tb.querySelectorAll('*')]
          const desc = (e) => `${e.tagName}.${e.className} sw=${e.scrollWidth}/${e.clientWidth} sh=${e.scrollHeight}/${e.clientHeight} "${(e.textContent || '').slice(0, 28)}"`
          const over = els.filter((e) => e.clientWidth > 0 && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1))
          // Ellipsis is truncation by design (the flow label in a narrow
          // strip) — reported, not failed.
          const truncated = over.filter((e) => getComputedStyle(e).textOverflow === 'ellipsis').map(desc)
          // A glyph's ink box a pixel or two taller than a `line-height: 1`
          // box (the −/+ stepper glyphs) is not clipped while overflow is
          // visible — ignored below 3px.
          const overflow = over
            .filter((e) => getComputedStyle(e).textOverflow !== 'ellipsis')
            .filter((e) => {
              const s = getComputedStyle(e)
              const visible = s.overflowX === 'visible' && s.overflowY === 'visible'
              return !visible || e.scrollWidth - e.clientWidth > 2 || e.scrollHeight - e.clientHeight > 2
            })
            .map(desc)
          // Any two leaf text nodes whose rects intersect = an overlap.
          const leaves = els.filter((e) => e.children.length === 0 && (e.textContent || '').trim())
          const overlaps = []
          for (let i = 0; i < leaves.length; i++) {
            for (let j = i + 1; j < leaves.length; j++) {
              const a = leaves[i].getBoundingClientRect(), b = leaves[j].getBoundingClientRect()
              if (a.width && b.width && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) {
                overlaps.push(`"${leaves[i].textContent.slice(0, 18)}" x "${leaves[j].textContent.slice(0, 18)}"`)
              }
            }
          }
          const tbr = tb.getBoundingClientRect()
          const outside = els.filter((e) => {
            const b = e.getBoundingClientRect()
            return b.width > 0 && (b.right > tbr.right + 1 || b.left < tbr.left - 1)
          }).map((e) => `${e.tagName}.${e.className}`)
          out[name] = { w: Math.round(tbr.width), overflow, overlaps, outside, truncated }
        }
        return { containers: out, hscroll: document.documentElement.scrollWidth > window.innerWidth }
      })
      log(width, J(r))
      const clean = Object.values(r.containers).every((c) => !c.overflow.length && !c.overlaps.length && !c.outside.length)
      assert(`overflow@${width} clean`, clean && !r.hscroll)
      await ctx.close()
    }
  }

  if (phase === 'state') {
    const { ctx, page, console_ } = await boot(browser, { width: Number(opt('width', 1440)) })
    for (const f of ['bike', 'migration']) log(`ARIA ${f}`, J(await readAria(page, f, 0)))
    const css = await page.evaluate((flow) => {
      const q = (s) => document.querySelector(s)
      const pick = (e, props) => {
        if (!e) return null
        const s = getComputedStyle(e)
        return Object.fromEntries(props.map((p) => [p, s[p]]))
      }
      const row = q(`#dashboard article[class*="panel"] div[class*="flowRow"][data-flow="${flow}"]`)
      const root = row.querySelector('div[class*="hourSlider"]')
      const thumbs = [...root.querySelectorAll('[role=slider]')]
      const ticks = [...root.querySelectorAll('[class*="tick"]')]
      const tppField = row.querySelector('input[role=spinbutton]')
      const steppers = [...row.querySelectorAll('button[class*="stepper"]')]
      return {
        rail: pick(root.querySelector('[class*="rail"]'), ['height', 'backgroundColor', 'borderRadius']),
        fill: pick(root.querySelector('[class*="fill"]'), ['height', 'backgroundColor', 'left', 'right', 'width']),
        thumb0: pick(thumbs[0], ['width', 'height', 'backgroundColor', 'borderRadius', 'boxShadow', 'left']),
        thumb1: pick(thumbs[1], ['width', 'height', 'backgroundColor', 'borderRadius', 'boxShadow', 'left']),
        tickCount: ticks.length,
        ticks: ticks.map((t) => ({ left: t.style.left, ...pick(t, ['width', 'height', 'backgroundColor']) })),
        bounds: [...root.querySelectorAll('[class*="bound"]')].map((b) => b.textContent),
        readoutColor: pick(row.querySelector('span[class*="hourValue"]'), ['color']),
        // NumberInput (Carbon number input on --layer-01 → --field-02 field).
        tppRoot: pick(tppField?.parentElement, ['height', 'backgroundColor', 'borderBottom', 'borderRadius', 'boxShadow', 'outline']),
        tppInput: pick(tppField, ['width', 'height', 'color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontVariantNumeric', 'textAlign', 'borderRadius']),
        tppStepper: pick(steppers[0], ['width', 'height', 'color', 'backgroundColor', 'borderLeft', 'borderRadius', 'boxShadow', 'cursor']),
        stepperCount: steppers.length,
        scale: pick(row.querySelector('div[class*="flowScale"]'), ['color', 'font', 'gap']),
        // Flat 0px corners and no drop shadows are design-system rules
        // (DESIGN-ibm.md) — borderRadius/boxShadow above are how they're checked.
        tokens: Object.fromEntries(['--link', '--text-primary', '--text-secondary', '--border-strong', '--border-subtle-02', '--focus', '--field-02', '--field-hover-02']
          .map((k) => [k, getComputedStyle(document.documentElement).getPropertyValue(k).trim()])),
        smoothing: (() => {
          const s = q('#dashboard input[class*="slider"]')
          if (!s) return 'MISSING'
          const b = s.getBoundingClientRect()
          return { ...pick(s, ['width', 'height', 'appearance', 'cursor']), visible: b.width > 0 }
        })(),
      }
    }, FLOW)
    log('CSS', J(css))
    // Stepper hover must step to --field-hover-02 (#474747 = rgb(71, 71, 71)).
    const inc = rowAt(page, 0, FLOW).locator(SEL.stepper).last()
    await inc.hover()
    await page.waitForTimeout(250)
    log('stepper hover', J(await inc.evaluate((b) => ({ bg: getComputedStyle(b).backgroundColor, disabled: b.disabled }))))
    await page.mouse.move(0, 0)
    await tpp(page, 0, FLOW).focus()
    await page.waitForTimeout(150)
    log('tpp focus', J(await tpp(page, 0, FLOW).evaluate((i) => {
      const r = getComputedStyle(i.parentElement)
      return { outline: r.outline, boxShadow: r.boxShadow, activeIsField: document.activeElement === i }
    })))
    await crop(page, rowAt(page, 0, FLOW).locator('div[class*="flowScale"]'), 'tpp-focus-zoom')
    await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {})
    await crop(page, rowAt(page, 0, FLOW).locator(SEL.slider.replace('#dashboard ', '')), 'slider-default-zoom')
    log('swarm ready after', await waitForSwarm(page, console_, { flow: 'migration' }), 's')
    await shot(page, SEL.canvas, 'panel-canvas-default')
    await shot(page, SEL.bottomLeft, 'panel-smoothing')
    log('canvas', J(analyze(path.join(OUT, 'panel-canvas-default.png'))))
    await ctx.close()
  }

  if (phase === 'keys') {
    const { ctx, page } = await boot(browser, { width: Number(opt('width', 1440)) })
    // Only migration is on by default; a switched-off flow's controls are disabled.
    if (FLOW !== 'migration') { await checkbox(page, 0, FLOW).check(); await page.waitForTimeout(300) }
    const snap = async (tag) => log(tag, J(await readAria(page, FLOW, 0)))
    const lo = thumb(page, 0, FLOW, 'start'), hi = thumb(page, 0, FLOW, 'end')
    log(`flow=${FLOW} default expected 7/10`)
    await snap('initial')
    await lo.focus()
    for (let k = 0; k < 2; k++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(60) }
    await snap('lo +2 (expect 9)')
    await page.keyboard.press('ArrowRight'); await page.waitForTimeout(80)
    await snap('lo +3rd (expect minGap holds: lo 9, hi 10)')
    await page.keyboard.press('Home'); await page.waitForTimeout(80)
    await snap('lo Home (expect 0)')
    await hi.focus()
    await page.keyboard.press('End'); await page.waitForTimeout(80)
    await snap('hi End (expect 24, readout 00:00–24:00)')
    await page.keyboard.press('PageDown'); await page.waitForTimeout(80)
    await snap('hi PageDown (expect 21)')
    await crop(page, rowAt(page, 0, FLOW).locator('div[class*="hourSlider"]'), 'focus-ring-1440')
    await rowAt(page, 0, FLOW).locator('div[class*="hourSlider"]').dblclick()
    await page.waitForTimeout(400)
    await snap('dblclick reset (expect 7/10)')

    // Trips-per-particle NumberInput: typing edits a draft; Enter / blur / ↑↓
    // commit (snapped to 500, clamped 1,000–100,000); Escape / garbage / empty revert.
    const field = tpp(page, 0, FLOW)
    const val = async () => field.evaluate((i) => ({ value: i.value, now: Number(i.getAttribute('aria-valuenow')) }))
    const start = (await val()).now
    const check = async (tag, expect) => {
      await page.waitForTimeout(120)
      const v = await val()
      assert(`keys tpp ${tag}`, v.now === expect && v.value === expect.toLocaleString('en-US'), { expect, ...v })
    }
    await field.focus()
    await page.keyboard.press('ArrowUp')
    await check('ArrowUp', start + 500)
    const up = start + 500
    await field.fill('12000'); await field.press('Escape')
    await check('typed then Escape reverts', up)
    await field.fill('abc'); await field.press('Enter')
    await check('"abc" + Enter reverts', up)
    await field.fill('7777'); await field.press('Enter')
    await check('"7777" snaps to 8,000', 8000)
    await field.fill('123456'); await field.press('Enter')
    await check('"123456" clamps to 100,000', 100000)
    await field.fill(''); await field.blur()
    await check('empty + blur reverts', 100000)
    await field.focus(); await page.keyboard.press('ArrowDown')
    await check('ArrowDown', 99500)
    await ctx.close()

    // Narrowest width with a thumb focused — the min-gap thumbs must not collide.
    const s = await boot(browser, { width: 360 })
    if (FLOW !== 'migration') { await checkbox(s.page, 0, FLOW).check(); await s.page.waitForTimeout(300) }
    await thumb(s.page, 0, FLOW, 'end').focus()
    for (let k = 0; k < 4; k++) { await s.page.keyboard.press('ArrowRight'); await s.page.waitForTimeout(40) }
    await thumb(s.page, 0, FLOW, 'start').focus()
    for (let k = 0; k < 6; k++) { await s.page.keyboard.press('ArrowRight'); await s.page.waitForTimeout(40) }
    await s.page.waitForTimeout(200)
    log('min-gap @360', J(await readAria(s.page, FLOW, 0)))
    await crop(s.page, rowAt(s.page, 0, FLOW).locator('div[class*="hourSlider"]'), 'mingap-focus-360')
    await s.ctx.close()
  }

  if (phase === 'pointer') {
    const { ctx, page } = await boot(browser, { width: 1440 })
    if (FLOW !== 'migration') { await checkbox(page, 0, FLOW).check(); await page.waitForTimeout(300) }
    const g = await railBox(page, FLOW, 0)
    const at = (r) => ({ x: g.left + r * g.width, y: g.top + g.height / 2 })
    const p = at(0.75)
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.waitForTimeout(80)
    log('press @75% (expect hi->18)', J(await readAria(page, FLOW, 0)))
    const mid = at(0.5)
    await page.mouse.move(mid.x, mid.y, { steps: 10 }); await page.waitForTimeout(80)
    log('drag to 50% (expect hi->12)', J(await readAria(page, FLOW, 0)))
    log('scrollX during drag', await page.evaluate(() => [window.scrollX, document.documentElement.scrollLeft]))
    await page.mouse.up(); await page.waitForTimeout(100)
    const far = at(0.02)
    await page.mouse.click(far.x, far.y); await page.waitForTimeout(120)
    log('click far left (expect lo->0)', J(await readAria(page, FLOW, 0)))
    await ctx.close()

    const t = await boot(browser, { width: 360, hasTouch: true })
    if (FLOW !== 'migration') { await checkbox(t.page, 0, FLOW).check(); await t.page.waitForTimeout(300) }
    const g2 = await railBox(t.page, FLOW, 0)
    const before = await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    await t.page.touchscreen.tap(g2.left + g2.width * 0.9, g2.top + g2.height / 2)
    await t.page.waitForTimeout(150)
    log('touch tap @90% (expect hi->~22)', J(await readAria(t.page, FLOW, 0)))
    log('no-hscroll before/after', before, await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    await t.ctx.close()
  }

  if (phase === 'disabled') {
    const { ctx, page } = await boot(browser, { width: 1440 })
    log('flow checkboxes', await page.locator(SEL.checks).count())
    const states = () => page.evaluate(() =>
      [...document.querySelectorAll('#dashboard article[class*="panel"] div[class*="flowRow"][data-flow] input[type=checkbox]')]
        .map((i) => [i.getAttribute('aria-label'), i.checked]))
    log('before', J(await states()))
    // Migration is the only flow on by default (FLOWS defaultOn, odTrips.ts);
    // bike starts off, so its controls must already be disabled.
    const bike = await readAria(page, 'bike', 0)
    log('bike (off) ARIA', J(bike))
    assert('disabled bike-off tpp + steppers disabled', bike.tpp.disabled && bike.tpp.steppers.every((s) => s.endsWith('disabled')), bike.tpp)
    await checkbox(page, 0, 'migration').uncheck()
    await page.waitForTimeout(300)
    log('after uncheck', J(await states()))
    const off = await readAria(page, 'migration', 0)
    log('disabled ARIA', J(off))
    assert('disabled slider aria-disabled', off.lo?.disabled === 'true' && off.hi?.disabled === 'true', [off.lo?.disabled, off.hi?.disabled])
    assert('disabled tpp + steppers disabled', off.tpp.disabled && off.tpp.steppers.every((s) => s.endsWith('disabled')), off.tpp)
    const g = await railBox(page, 'migration', 0)
    await page.mouse.click(g.left + g.width * 0.9, g.top + g.height / 2)
    await page.waitForTimeout(200)
    const after = await readAria(page, 'migration', 0)
    log('click on disabled rail (expect unchanged)', J(after))
    assert('disabled rail click ignored', after.hi?.now === off.hi?.now, [off.hi?.now, after.hi?.now])
    await crop(page, rowAt(page, 0, 'migration'), 'slider-disabled')
    await checkbox(page, 0, 'migration').check()
    await page.waitForTimeout(300)
    const on = await readAria(page, 'migration', 0)
    log('re-enabled ARIA', J(on))
    assert('re-enabled tpp enabled', !on.tpp.disabled, on.tpp)
    await ctx.close()
  }

  if (phase === 'noblank') {
    const { ctx, page, console_, failed, rpc, pageerrors } = await boot(browser, { width: 1440 })
    log('swarm ready after', await waitForSwarm(page, console_, { flow: 'migration' }), 's')
    const canvas = page.locator(SEL.canvas).first()
    await canvas.screenshot({ path: path.join(OUT, 'noblank-t0.png') })
    // An hour change keys a NEW schedule for this panel's flow (the window is
    // part of the schedule key): the flow may blank for the 0–2 s the reservoir
    // takes to land, then the new swarm appears mid-flight. t3s / t9s must have
    // refilled.
    await thumb(page, 0, FLOW, 'end').focus()
    await page.keyboard.press('PageUp')
    await page.waitForTimeout(300)
    await canvas.screenshot({ path: path.join(OUT, 'noblank-t300ms.png') })
    await page.waitForTimeout(3000)
    await canvas.screenshot({ path: path.join(OUT, 'noblank-t3s.png') })
    await page.waitForTimeout(6000)
    await canvas.screenshot({ path: path.join(OUT, 'noblank-t9s.png') })
    const px = {}
    for (const f of ['noblank-t0', 'noblank-t300ms', 'noblank-t3s', 'noblank-t9s']) {
      px[f] = analyze(path.join(OUT, `${f}.png`))
      log(f, J(px[f]))
    }
    const key = FLOW === 'bike' ? 'bright' : 'yellow'
    assert('noblank refilled by t9s', px['noblank-t9s'][key] > 0.3 * px['noblank-t0'][key], [px['noblank-t0'][key], px['noblank-t9s'][key]])
    log('ARIA after PageUp', J(await readAria(page, FLOW, 0)))
    log('RPC', J(rpc))
    log('CONSOLE', J(console_.filter(noise)))
    log('FAILED', J(failed))
    log('PAGEERRORS', J(pageerrors))
    await ctx.close()
  }

  if (phase === 'panels') {
    const { ctx, page, console_, rpc, pageerrors, failed } = await boot(browser, { width: Number(opt('width', 1440)) })
    const add = Number(opt('add', 2))
    log('swarm ready after', await waitForSwarm(page, console_, { flow: 'migration' }), 's')
    // A panel added later copies the previous panel's settings, so it joins
    // the same shared schedule mid-flight; give its terrain and GPU buffers
    // time to build before the next click.
    await addPanels(page, add, 3000)
    await page.waitForTimeout(3000)
    const count = await page.locator(SEL.panel).count()
    log('panels', count)
    await shot(page, SEL.toolbar, `toolbar-${add + 1}panels`)
    // Copy check: every panel shows panel 1's settings.
    for (let i = 0; i < count; i++) {
      const s = {}
      for (const f of ['bike', 'migration']) {
        const a = await readAria(page, f, i)
        s[f] = { on: a.on, readout: a.readout, scale: await readScale(page, f, i) }
      }
      log(`panel${i + 1} settings`, J(s))
    }
    const n = await page.locator(SEL.canvas).count()
    // Panels with identical settings play the same trips in lockstep
    // (sharedTripSchedule), so the per-canvas particle counts should be close —
    // only the terrain differs.
    for (let i = 0; i < n; i++) {
      const f = path.join(OUT, `panel${i + 1}-canvas.png`)
      await page.locator(SEL.canvas).nth(i).screenshot({ path: f })
      log(`panel${i + 1}`, J(analyze(f)))
    }
    await page.screenshot({ path: path.join(OUT, `dashboard-${add + 1}panels.png`) })
    log('hscroll', await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]))
    log('CONSOLE', J(console_.filter(noise)))
    log('RPC', J(rpc))
    log('FAILED', J(failed))
    log('PAGEERRORS', J(pageerrors))
    await ctx.close()
  }

  if (phase === 'perflow') {
    // Each (panel, flow) window leases its own reservoir, so moving one flow's
    // window must issue RPCs for that flow only (sample_*_hourly) and leave the
    // other's reservoir playing.
    for (const width of WIDTHS) {
      const { ctx, page, rpc, console_ } = await boot(browser, { width })
      await crop(page, SEL.flowRows, `perflow-${width}-a`)
      await checkbox(page, 0, 'bike').check()
      await page.waitForTimeout(2500)
      const before = rpc.length
      await thumb(page, 0, 'bike', 'end').focus()
      for (let k = 0; k < 10; k++) await page.keyboard.press('ArrowRight')
      await thumb(page, 0, 'bike', 'start').focus()
      for (let k = 0; k < 10; k++) await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(3000)
      const after = rpc.slice(before)
      const sliders = await panelAt(page, 0).getByRole('slider').evaluateAll((els) =>
        els.map((e) => `${e.getAttribute('aria-label')}=${e.getAttribute('aria-valuenow')} @x${Math.round(e.getBoundingClientRect().x)}`))
      const geo = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        iw: window.innerWidth,
        rails: [...document.querySelectorAll('#dashboard article[class*="panel"] div[class*="hourSlider"]')]
          .map((g) => { const r = g.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)] }),
      }))
      await crop(page, SEL.flowRows, `perflow-${width}-b`)
      const migrationRequeried = after.some((r) => r.fn?.includes('living_migration'))
      log(J({
        width,
        hscroll: geo.sw > geo.iw,
        rails: geo.rails,
        sliders,
        rpcAfterBikeMove: [...new Set(after.map((r) => r.fn))],
        migrationRequeried,
        count: after.length,
        console: console_.filter((c) => c.includes('urban-flow')),
      }, null, 1))
      assert(`perflow@${width} migration not re-queried`, !migrationRequeried)
      await ctx.close()
    }
  }

  if (phase === 'perpanel') {
    // Two panels, one flow (bike — fully live), different settings: each panel
    // runs its own schedule; identical settings share one and move in lockstep.
    const { ctx, page, console_, rpc, failed, pageerrors } = await boot(browser, { width: 1440 })
    if (await page.locator(SEL.hourHint).isVisible().catch(() => false)) {
      log('SKIP perpanel: "Live OD data unavailable" — per-panel windows need Supabase')
    } else {
      await checkbox(page, 0, 'bike').check()
      await checkbox(page, 0, 'migration').uncheck()
      log('bike swarm ready after', await waitForSwarm(page, console_, { flow: 'bike' }), 's')

      // A new panel copies the previous panel's settings.
      await addPanels(page, 1, 3000)
      const b2 = await readAria(page, 'bike', 1), m2 = await readAria(page, 'migration', 1)
      const s2 = await readScale(page, 'bike', 1)
      log('panel2 copied', J({ bike: { on: b2.on, lo: b2.lo?.now, hi: b2.hi?.now, tpp: b2.tpp?.now, scale: s2 }, migration: { on: m2.on } }))
      assert('perpanel panel 2 copied panel 1',
        b2.on === true && m2.on === false && b2.lo?.now === '7' && b2.hi?.now === '10' && b2.tpp?.now === '15000',
        { bikeOn: b2.on, migrationOn: m2.on, lo: b2.lo?.now, hi: b2.hi?.now, tpp: b2.tpp?.now })

      // Different windows: panel 2 00–24 (whole day), panel 1 02–05 (quietest).
      // Page errors so far, after each step — which action an app error follows.
      const mark = (tag) => log(`  errors after ${tag}: ${pageerrors.length}`)
      mark('add panel')
      await setWindow(page, 1, 'bike', 0, 24)
      await page.waitForTimeout(1500)
      mark('panel 2 → 00–24')
      await setWindow(page, 0, 'bike', 2, 5)
      await page.waitForTimeout(14000)
      mark('panel 1 → 02–05')
      const grab = async (i, name) => {
        const f = path.join(OUT, `${name}.png`)
        await page.locator(SEL.canvas).nth(i).screenshot({ path: f })
        return analyze(f)
      }
      const p1 = await grab(0, 'perpanel-p1-02-05'), p2 = await grab(1, 'perpanel-p2-00-24')
      const sc1 = await readScale(page, 'bike', 0), sc2 = await readScale(page, 'bike', 1)
      log('windows', J({ p1: { scale: sc1, pixels: p1 }, p2: { scale: sc2, pixels: p2 } }))
      assert('perpanel 00–24 far denser than 02–05 (p2.bright > 3 × p1.bright)', p2.bright > 3 * p1.bright,
        { p1: p1.bright, p2: p2.bright, particles: [sc1?.particles, sc2?.particles] })

      // Trips per particle in panel 1 only: 15,000 → 5,000 = ~3× its particles.
      await setTpp(page, 0, 'bike', 5000)
      await page.waitForTimeout(1000)
      mark('panel 1 tpp 5,000')
      const t1 = await readScale(page, 'bike', 0), t2 = await readScale(page, 'bike', 1)
      log('tpp 5,000 on panel 1', J({ p1: t1, p2: t2 }))
      assert('perpanel tpp raises panel 1 data-particles', t1.particles > sc1.particles, [sc1.particles, t1.particles])
      assert('perpanel tpp leaves panel 2 unchanged', t2.particles === sc2.particles, [sc2.particles, t2.particles])

      // Equalise: panel 1 → 00–24 at 15,000 = panel 2's settings → one shared
      // schedule, lockstep, near-equal pixel counts. Both canvases are counted
      // from ONE viewport screenshot (the same frame): sequential element shots
      // are 0.5–1 s apart under SwiftShader and drift ~15% on their own.
      await setWindow(page, 0, 'bike', 0, 24)
      await page.waitForTimeout(1500)
      mark('panel 1 → 00–24 (at 5,000)')
      await setTpp(page, 0, 'bike', 15000)
      await page.waitForTimeout(14000)
      mark('panel 1 tpp 15,000')
      const c1 = page.locator(SEL.canvas).nth(0), c2 = page.locator(SEL.canvas).nth(1)
      await c1.scrollIntoViewIfNeeded()
      const vp = page.viewportSize()
      const [bb1, bb2] = [await c1.boundingBox(), await c2.boundingBox()]
      const inside = (b) => b.x >= 0 && b.y >= 0 && b.x + b.width <= vp.width && b.y + b.height <= vp.height
      assert('perpanel lockstep canvases fully in viewport', inside(bb1) && inside(bb2), { bb1, bb2, vp })
      // Screenshot pixels per CSS px (1 here; >1 if deviceScaleFactor is raised).
      const frame = path.join(OUT, 'perpanel-lockstep-frame.png')
      const k0 = vp.width
      const region = (b, k) => ({ x: b.x * k, y: b.y * k, w: b.width * k, h: b.height * k })
      // Panel 1's layer was just rebuilt (new schedule, new count), and a fresh
      // layer's trail ring starts empty: it fills one snapshot every trailGap
      // steps (40 × 6 = 240 steps: 8 s at 30 fps, far longer under SwiftShader).
      // Until then panel 1 draws shorter trails than panel 2 and the gap
      // shrinks frame by frame (13% → 3% over 6 s in one run). So sample the same frame every 2 s until the
      // gap settles (≤ 30 s), logging the whole trajectory, and assert on the
      // last frame.
      let l1, l2, rel, t = 0
      const trajectory = []
      for (;;) {
        await page.screenshot({ path: frame })
        const k = decodePng(fs.readFileSync(frame)).w / k0
        l1 = analyze(frame, region(bb1, k)); l2 = analyze(frame, region(bb2, k))
        rel = Math.abs(l1.bright - l2.bright) / Math.max(1, l1.bright, l2.bright)
        trajectory.push([t, l1.bright, l2.bright, Math.round(rel * 1000) / 1000])
        if (rel < 0.05 || t >= 30) break
        await page.waitForTimeout(2000)
        t += 2
      }
      log('lockstep trajectory [s after first frame, b1, b2, rel]', J(trajectory))
      log('lockstep (same frame)', J({ p1: { scale: await readScale(page, 'bike', 0), pixels: l1 }, p2: { scale: await readScale(page, 'bike', 1), pixels: l2 }, rel }))
      assert('perpanel identical settings in lockstep, same frame (|b1−b2|/max < 0.05)', rel < 0.05, { b1: l1.bright, b2: l2.bright, rel: Math.round(rel * 1000) / 1000, settledAfter: `${14 + t} s` })
    }
    log('CONSOLE', J(console_.filter(noise)))
    log('RPC', J(rpc.map((r) => `${r.fn} ${r.body}`)))
    log('FAILED', J(failed))
    log('PAGEERRORS', J(pageerrors))
    await ctx.close()
  }

  if (phase === 'bike') {
    const { ctx, page, console_, rpc, failed, pageerrors } = await boot(browser, { width: 1440 })
    await checkbox(page, 0, 'bike').check()
    log('bike swarm ready after', await waitForSwarm(page, console_, { flow: 'bike' }), 's')
    await shot(page, SEL.canvas, 'bike-on-canvas')
    log('canvas', J(analyze(path.join(OUT, 'bike-on-canvas.png'))))
    await crop(page, SEL.flowRows, 'panelcontrols-both-flows')
    log('scale', J({ bike: await readScale(page, 'bike', 0), migration: await readScale(page, 'migration', 0) }))
    log('CONSOLE', J(console_.filter((c) => c.includes('urban-flow'))))
    log('RPC', J(rpc.map((r) => `${r.fn} ${r.body}`)))
    log('FAILED', J(failed))
    log('PAGEERRORS', J(pageerrors))
    await ctx.close()
  }

  if (phase === 'volume') {
    // Particles = trips in the window ÷ trips per particle, so a quiet window
    // must draw visibly fewer than a peak one. `particles` is the count the
    // dashboard resolved; the pixel census says whether the canvas agrees.
    const { ctx, page, console_, pageerrors } = await boot(browser, { width: 1440 })
    if (FLOW === 'bike') await checkbox(page, 0, 'bike').check()
    await waitForSwarm(page, console_, { flow: FLOW })
    const canvas = page.locator(SEL.canvas).first()
    for (const [from, to] of [[2, 5], [7, 10], [17, 20], [0, 24]]) {
      await setWindow(page, 0, FLOW, from, to)
      // Debounced commit + reservoir fetch + the new schedule's swarm forming.
      await page.waitForTimeout(14000)
      const name = `volume-${FLOW}-${String(from).padStart(2, '0')}-${String(to).padStart(2, '0')}`
      const f = path.join(OUT, `${name}.png`)
      await canvas.screenshot({ path: f })
      log(J({ window: `${from}-${to}`, scale: await readScale(page, FLOW, 0), pixels: analyze(f) }))
    }
    log('CONSOLE', J(console_.filter(noise)))
    log('PAGEERRORS', J(pageerrors))
    await ctx.close()
  }

  if (phase === 'tune') {
    // Each preset is a knob set applied to a flat 2D view, screenshotted before
    // and after so the two reads sit side by side. `tpp:<flow>` entries are not
    // lil-gui knobs: trips per particle is panel 1's NumberInput (setTpp).
    const PRESETS = {
      defaults: null, // read the shipped values back instead of setting any
      // Fewer trips per particle = more particles (8,000 → 2,000 is 4×).
      count: [['tpp:migration', 2000]],
      scatter: [['migration scatter', 0]],
      ramp: [['arrival ramp', 0]],
      trend: [
        ['tpp:migration', 2000], ['glow (halo strength)', 1.5], ['halo size (× dot)', 5],
        ['trail length', 40], ['trail opacity', 0.3], ['opacity', 0.12],
      ],
    }
    const preset = opt('preset', 'defaults')
    const knobs = PRESETS[preset]
    if (knobs === undefined) throw new Error(`unknown preset '${preset}' — try ${Object.keys(PRESETS).join('|')}`)
    // `ramp` reads as trails, which need the pixel density of a zoomed 2x crop.
    const zoomed = preset === 'ramp'
    const { ctx, page, console_, pageerrors } = await boot(browser, {
      width: 1440, height: 1000, scale: zoomed ? 2 : 1, tune: true,
    })
    const canvas = page.locator('canvas').last()
    await canvas.scrollIntoViewIfNeeded()
    await flatten(page, { zoom: zoomed ? 2 : 0 })
    log('swarm ready after', await waitForSwarm(page, console_, { flow: 'migration' }), 's')

    const box = await canvas.boundingBox()
    const clip = zoomed
      ? { x: box.x + box.width * 0.2, y: box.y + box.height * 0.2, width: box.width * 0.6, height: box.height * 0.6 }
      : null
    const grab = async (name) => {
      const f = path.join(OUT, `${name}.png`)
      if (clip) await page.screenshot({ path: f, clip })
      else await canvas.screenshot({ path: f })
      log(name, J(analyze(f)))
    }

    await grab(`${preset}-before`)
    const scaleBefore = { bike: await readScale(page, 'bike', 0), migration: await readScale(page, 'migration', 0) }
    if (knobs) {
      for (const [label, v] of knobs) {
        if (label.startsWith('tpp:')) await setTpp(page, 0, label.slice(4), v)
        else await setKnob(page, label, v)
      }
      // A new count rebuilds the layer's GPU buffers, so give the swarm time to
      // re-form before the second read.
      await page.waitForTimeout(15000)
      await canvas.scrollIntoViewIfNeeded()
      await grab(`${preset}-after`)
    }
    log('scale before', J(scaleBefore))
    log('scale', J({ bike: await readScale(page, 'bike', 0), migration: await readScale(page, 'migration', 0) }))
    log('knobs', J(await readKnobs(page, [
      'size (px)', 'glow (halo strength)', 'halo size (× dot)',
      'trail length', 'trail opacity', 'arrival ramp', 'migration scatter',
    ])))
    log('opacity [contours, boundary, park, river, particles]', J(await readOpacities(page)))
    log('CONSOLE', J(console_.filter(noise)))
    log('PAGEERRORS', J(pageerrors))
    await ctx.close()
  }
} finally {
  await browser.close()
}
