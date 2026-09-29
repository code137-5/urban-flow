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
//   layout    toolbar geometry + screenshot across the responsive width sweep
//   overflow  clipping / text-overlap / out-of-bounds detector per width
//   state     computed CSS, theme tokens, ARIA and zoomed slider crops
//   keys      keyboard ARIA transitions on one flow's hour slider
//   pointer   mouse press/drag/click + touch tap on the rail
//   disabled  a flow switched off disables its hour slider
//   noblank   canvas right after an hour change — the swarm must clear, not blank
//   panels    grow to three panels, analyze each canvas
//   perflow   moving one flow's window must not re-query the other
//   bike      switch the bike flow on, analyze the canvas
//   tune      drive the `?tune` knobs; --preset defaults|count|scatter|ramp|trend
//
// Screenshots land in .preview/ (gitignored). Every phase prints JSON to stdout.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/* ---------------------------------------------------------------- options */

const PHASES = ['layout', 'overflow', 'state', 'keys', 'pointer', 'disabled', 'noblank', 'panels', 'perflow', 'bike', 'tune']

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
// 1312/1313 straddle the toolbar's last breakpoint — keep both.
const WIDTHS = (opt('width') ? [Number(opt('width'))] : [360, 672, 1056, 1312, 1313, 1440])
const FLOW = opt('flow', 'migration')

const log = (...a) => console.log(...a)
const J = (o) => JSON.stringify(o)

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
 */
function analyze(file) {
  const { w, h, px } = decodePng(fs.readFileSync(file))
  let yellow = 0, bright = 0, nonBg = 0
  for (let i = 0; i < w * h; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2]
    if (r > 120 && g > 90 && b < 110 && r - b > 55 && g - b > 35) yellow++
    if (r > 200 && g > 200 && b > 200) bright++
    if (Math.abs(r - 22) > 14 || Math.abs(g - 22) > 14 || Math.abs(b - 22) > 14) nonBg++
  }
  return { w, h, yellow, bright, nonBg, total: w * h }
}

/* -------------------------------------------------------------- selectors */

// CSS Modules hash every classname, hence the [class*=] matching. Names mirror
// src/sections/Dashboard.module.css and src/ui/RangeSlider.module.css.
const SEL = {
  toolbar: '#dashboard div[class*="toolbar"]',
  flowRows: '#dashboard div[class*="flowRows"]',
  checks: '#dashboard div[class*="flowRow"] input[type=checkbox]',
  syncViews: '#dashboard label[class*="syncViews"]',
  hourHint: '#dashboard span[class*="hourHint"]',
  // The RangeSlider root carries both .root and the .hourSlider passed as
  // className, plus role="group".
  slider: '#dashboard div[class*="hourSlider"]',
  geometry: '#dashboard div[class*="hourSlider"] [class*="geometry"]',
  track: '#dashboard div[class*="hourSlider"] [class*="track"]',
  readout: '#dashboard span[class*="hourValue"]',
  panel: '#dashboard article[class*="panel"]',
  canvas: '#dashboard article[class*="panel"] div[class*="canvas"]',
  addPanel: '#dashboard button[class*="addPanel"]',
  smoothing: '#dashboard input[class*="slider"]',
  bottomLeft: '#dashboard div[class*="bottomLeft"]',
}

// Prefixes of the `label` fields in FLOWS (src/data/odTrips.ts) — matched as a
// prefix so the Korean parenthetical can change without breaking the harness.
const FLOW_LABEL = { bike: 'Bike', migration: 'Living migration' }

/** One flow's start/end thumb, via the per-flow aria-label Dashboard.tsx:288 builds. */
const thumb = (page, flow, edge) =>
  page.getByRole('slider', { name: new RegExp(`^${FLOW_LABEL[flow]}.*${edge} hour$`) })

/** That flow's row index, for the readout/root that has no aria hook of its own. */
const rowIndex = (flow) => (flow === 'bike' ? 0 : 1)

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
  page.on('pageerror', (e) => pageerrors.push(String(e)))
  page.on('requestfailed', (r) => failed.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`))
  page.on('request', (r) => {
    if (r.url().includes('/rest/v1/rpc/')) rpc.push({ fn: r.url().split('/rpc/')[1], body: r.postData() })
  })
  await page.goto(tune ? `${BASE_URL}?tune` : BASE_URL, { waitUntil: 'load' })
  await page.locator('#dashboard').scrollIntoViewIfNeeded()
  await page.waitForTimeout(settle)
  return { ctx, page, console_, failed, rpc, pageerrors }
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
  const b = await page.locator(sel).first().boundingBox()
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
 * an `opacity` (contours / boundary / park / river / particles — TerrainPanel
 * .tsx:483,487,491,495,516) and the particle one is the last of them. Matching
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

/** ARIA snapshot of one flow's two thumbs plus its readout. */
const readAria = (page, flow) =>
  page.evaluate(({ prefix, row }) => {
    const g = (edge) => {
      const e = [...document.querySelectorAll('#dashboard [role="slider"]')]
        .find((n) => (n.getAttribute('aria-label') ?? '').startsWith(prefix) &&
          (n.getAttribute('aria-label') ?? '').endsWith(`${edge} hour`))
      if (!e) return null
      return {
        now: e.getAttribute('aria-valuenow'), min: e.getAttribute('aria-valuemin'),
        max: e.getAttribute('aria-valuemax'), text: e.getAttribute('aria-valuetext'),
        label: e.getAttribute('aria-label'), tabindex: e.getAttribute('tabindex'),
        disabled: e.getAttribute('aria-disabled'),
      }
    }
    const ro = document.querySelectorAll('#dashboard span[class*="hourValue"]')[row]
    const root = document.querySelectorAll('#dashboard div[class*="hourSlider"]')[row]
    return {
      lo: g('start'), hi: g('end'),
      readout: ro?.textContent ?? null,
      // Codepoints catch an en-dash regressing to a hyphen.
      readoutCodes: ro ? [...ro.textContent].map((c) => c.codePointAt(0).toString(16)).join(' ') : null,
      rootOpacity: root ? getComputedStyle(root).opacity : null,
      rootClass: root?.className ?? null,
    }
  }, { prefix: FLOW_LABEL[flow], row: rowIndex(flow) })

/** Rail geometry of one flow's slider, in page coordinates, for pointer work. */
const railBox = (page, flow) =>
  page.evaluate((row) => {
    const g = document.querySelectorAll('#dashboard div[class*="hourSlider"] [class*="geometry"]')[row]
    const b = g.getBoundingClientRect()
    return { left: b.left, top: b.top, width: b.width, height: b.height }
  }, rowIndex(flow))

/* =========================================================== run a phase */

fs.mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ args: GL })
const noise = (c) => c.includes('urban-flow') || c.includes('error') || c.includes('Warning')

try {
  if (phase === 'layout') {
    for (const width of WIDTHS) {
      const { ctx, page, console_, pageerrors } = await boot(browser, { width })
      const geo = await page.evaluate(() => {
        const tb = document.querySelector('#dashboard div[class*="toolbar"]')
        const r = tb.getBoundingClientRect()
        const rowOf = (sel) => {
          const e = document.querySelector(sel)
          if (!e) return null
          const b = e.getBoundingClientRect()
          return {
            top: Math.round(b.top - r.top), left: Math.round(b.left - r.left),
            w: Math.round(b.width), h: Math.round(b.height),
          }
        }
        const rails = [...document.querySelectorAll('#dashboard div[class*="hourSlider"]')].map((e) => {
          const b = e.getBoundingClientRect()
          return { left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width) }
        })
        return {
          toolbar: { w: Math.round(r.width), h: Math.round(r.height) },
          flowRows: rowOf('#dashboard div[class*="flowRows"]'),
          sync: rowOf('#dashboard label[class*="syncViews"]'),
          // Both rails must start and end at the same x despite the flow
          // labels having different widths (Dashboard.tsx:243-248).
          rails,
          railsAligned: rails.length < 2 || rails.every((v) => v.left === rails[0].left && v.right === rails[0].right),
          readouts: [...document.querySelectorAll('#dashboard span[class*="hourValue"]')].map((e) => e.textContent),
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          sliderRoles: document.querySelectorAll('#dashboard [role=slider]').length,
          toolbarText: tb.innerText.replace(/\n/g, ' | '),
        }
      })
      await shot(page, SEL.toolbar, `toolbar-${width}`)
      log(J({ width, geo, hscroll: geo.scrollWidth > geo.innerWidth }))
      log('  console:', J(console_.filter(noise)))
      if (pageerrors.length) log('  PAGEERRORS:', J(pageerrors))
      await ctx.close()
    }
  }

  if (phase === 'overflow') {
    for (const width of WIDTHS) {
      const { ctx, page } = await boot(browser, { width })
      const r = await page.evaluate(() => {
        const tb = document.querySelector('#dashboard div[class*="toolbar"]')
        const els = [tb, ...tb.querySelectorAll('*')]
        const overflow = els
          .filter((e) => e.clientWidth > 0 && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1))
          .map((e) => `${e.tagName}.${e.className} sw=${e.scrollWidth}/${e.clientWidth} sh=${e.scrollHeight}/${e.clientHeight} "${(e.textContent || '').slice(0, 24)}"`)
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
        return { overflow, overlaps, outside, hscroll: document.documentElement.scrollWidth > window.innerWidth }
      })
      log(width, J(r))
      await ctx.close()
    }
  }

  if (phase === 'state') {
    const { ctx, page, console_ } = await boot(browser, { width: Number(opt('width', 1440)) })
    for (const f of ['bike', 'migration']) log(`ARIA ${f}`, J(await readAria(page, f)))
    const css = await page.evaluate((row) => {
      const q = (s) => document.querySelector(s)
      const pick = (e, props) => {
        if (!e) return null
        const s = getComputedStyle(e)
        return Object.fromEntries(props.map((p) => [p, s[p]]))
      }
      const root = document.querySelectorAll('#dashboard div[class*="hourSlider"]')[row]
      const thumbs = [...root.querySelectorAll('[role=slider]')]
      const ticks = [...root.querySelectorAll('[class*="tick"]')]
      return {
        rail: pick(root.querySelector('[class*="rail"]'), ['height', 'backgroundColor', 'borderRadius']),
        fill: pick(root.querySelector('[class*="fill"]'), ['height', 'backgroundColor', 'left', 'right', 'width']),
        thumb0: pick(thumbs[0], ['width', 'height', 'backgroundColor', 'borderRadius', 'boxShadow', 'left']),
        thumb1: pick(thumbs[1], ['width', 'height', 'backgroundColor', 'borderRadius', 'boxShadow', 'left']),
        tickCount: ticks.length,
        ticks: ticks.map((t) => ({ left: t.style.left, ...pick(t, ['width', 'height', 'backgroundColor']) })),
        bounds: [...root.querySelectorAll('[class*="bound"]')].map((b) => b.textContent),
        readoutColor: pick(q('#dashboard span[class*="hourValue"]'), ['color']),
        // Flat 0px corners and no drop shadows are design-system rules
        // (DESIGN-ibm.md) — borderRadius/boxShadow above are how they're checked.
        tokens: Object.fromEntries(['--link', '--text-primary', '--text-secondary', '--border-strong', '--border-subtle-02', '--focus']
          .map((k) => [k, getComputedStyle(document.documentElement).getPropertyValue(k).trim()])),
        smoothing: (() => {
          const s = q('#dashboard input[class*="slider"]')
          if (!s) return 'MISSING'
          const b = s.getBoundingClientRect()
          return { ...pick(s, ['width', 'height', 'appearance', 'cursor']), visible: b.width > 0 }
        })(),
      }
    }, rowIndex(FLOW))
    log('CSS', J(css))
    await crop(page, SEL.slider, 'slider-default-zoom')
    log('swarm ready after', await waitForSwarm(page, console_, { flow: 'migration' }), 's')
    await shot(page, SEL.canvas, 'panel-canvas-default')
    await shot(page, SEL.bottomLeft, 'panel-smoothing')
    log('canvas', J(analyze(path.join(OUT, 'panel-canvas-default.png'))))
    await ctx.close()
  }

  if (phase === 'keys') {
    const { ctx, page } = await boot(browser, { width: Number(opt('width', 1440)) })
    const snap = async (tag) => log(tag, J(await readAria(page, FLOW)))
    const lo = thumb(page, FLOW, 'start'), hi = thumb(page, FLOW, 'end')
    log(`flow=${FLOW} default expected 7/10`)
    await snap('initial')
    await lo.focus()
    for (let i = 0; i < 2; i++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(60) }
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
    await crop(page, SEL.slider, 'focus-ring-1440')
    await page.locator(SEL.slider).nth(rowIndex(FLOW)).dblclick()
    await page.waitForTimeout(400)
    await snap('dblclick reset (expect 7/10)')
    await ctx.close()

    // Narrowest width with a thumb focused — the min-gap thumbs must not collide.
    const s = await boot(browser, { width: 360 })
    await thumb(s.page, FLOW, 'end').focus()
    for (let i = 0; i < 4; i++) { await s.page.keyboard.press('ArrowRight'); await s.page.waitForTimeout(40) }
    await thumb(s.page, FLOW, 'start').focus()
    for (let i = 0; i < 6; i++) { await s.page.keyboard.press('ArrowRight'); await s.page.waitForTimeout(40) }
    await s.page.waitForTimeout(200)
    log('min-gap @360', J(await readAria(s.page, FLOW)))
    await crop(s.page, SEL.slider, 'mingap-focus-360')
    await s.ctx.close()
  }

  if (phase === 'pointer') {
    const { ctx, page } = await boot(browser, { width: 1440 })
    const g = await railBox(page, FLOW)
    const at = (r) => ({ x: g.left + r * g.width, y: g.top + g.height / 2 })
    const p = at(0.75)
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.waitForTimeout(80)
    log('press @75% (expect hi->18)', J(await readAria(page, FLOW)))
    const mid = at(0.5)
    await page.mouse.move(mid.x, mid.y, { steps: 10 }); await page.waitForTimeout(80)
    log('drag to 50% (expect hi->12)', J(await readAria(page, FLOW)))
    log('scrollX during drag', await page.evaluate(() => [window.scrollX, document.documentElement.scrollLeft]))
    await page.mouse.up(); await page.waitForTimeout(100)
    const far = at(0.02)
    await page.mouse.click(far.x, far.y); await page.waitForTimeout(120)
    log('click far left (expect lo->0)', J(await readAria(page, FLOW)))
    await ctx.close()

    const t = await boot(browser, { width: 360, hasTouch: true })
    const g2 = await railBox(t.page, FLOW)
    const before = await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    await t.page.touchscreen.tap(g2.left + g2.width * 0.9, g2.top + g2.height / 2)
    await t.page.waitForTimeout(150)
    log('touch tap @90% (expect hi->~22)', J(await readAria(t.page, FLOW)))
    log('no-hscroll before/after', before, await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    await t.ctx.close()
  }

  if (phase === 'disabled') {
    const { ctx, page } = await boot(browser, { width: 1440 })
    const boxes = page.locator(SEL.checks)
    log('flow checkboxes', await boxes.count())
    const states = () => page.evaluate(() =>
      [...document.querySelectorAll('#dashboard div[class*="flowRow"] input[type=checkbox]')]
        .map((i) => [i.closest('label').innerText.trim(), i.checked]))
    log('before', J(await states()))
    // Migration is the only flow on by default (FLOWS defaultOn, odTrips.ts).
    await boxes.nth(rowIndex('migration')).uncheck()
    await page.waitForTimeout(300)
    log('after uncheck', J(await states()))
    log('disabled ARIA', J(await readAria(page, 'migration')))
    const g = await railBox(page, 'migration')
    await page.mouse.click(g.left + g.width * 0.9, g.top + g.height / 2)
    await page.waitForTimeout(200)
    log('click on disabled rail (expect unchanged)', J(await readAria(page, 'migration')))
    await crop(page, SEL.slider, 'slider-disabled')
    await boxes.nth(rowIndex('migration')).check()
    await page.waitForTimeout(300)
    log('re-enabled ARIA', J(await readAria(page, 'migration')))
    await ctx.close()
  }

  if (phase === 'noblank') {
    const { ctx, page, console_, failed, rpc, pageerrors } = await boot(browser, { width: 1440 })
    log('swarm ready after', await waitForSwarm(page, console_, { flow: 'migration' }), 's')
    const canvas = page.locator(SEL.canvas).first()
    await canvas.screenshot({ path: path.join(OUT, 'noblank-t0.png') })
    // An hour change parks the swarm and wipes the trail rings, then it re-forms
    // with staggered departures (TripSchedule.reset). t300ms must not be empty
    // and t3s must have refilled.
    await thumb(page, FLOW, 'end').focus()
    await page.keyboard.press('PageUp')
    await page.waitForTimeout(300)
    await canvas.screenshot({ path: path.join(OUT, 'noblank-t300ms.png') })
    await page.waitForTimeout(3000)
    await canvas.screenshot({ path: path.join(OUT, 'noblank-t3s.png') })
    await page.waitForTimeout(6000)
    await canvas.screenshot({ path: path.join(OUT, 'noblank-t9s.png') })
    for (const f of ['noblank-t0', 'noblank-t300ms', 'noblank-t3s', 'noblank-t9s']) {
      log(f, J(analyze(path.join(OUT, `${f}.png`))))
    }
    log('ARIA after PageUp', J(await readAria(page, FLOW)))
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
    for (let i = 0; i < add; i++) {
      await page.locator(SEL.addPanel).click()
      // A panel added later joins the shared schedule mid-flight; give its
      // terrain and GPU buffers time to build before the next click.
      await page.waitForTimeout(3000)
    }
    await page.waitForTimeout(3000)
    log('panels', await page.locator(SEL.panel).count())
    await shot(page, SEL.toolbar, `toolbar-${add + 1}panels`)
    const n = await page.locator(SEL.canvas).count()
    // Every panel plays the same trips in lockstep (sharedTripSchedule), so the
    // per-canvas particle counts should be close — only the terrain differs.
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
    // Each flow's hour window is page-wide state keyed per flow, so moving one
    // must issue RPCs for that flow only (sample_*_hourly) and leave the other's
    // reservoir playing.
    for (const width of WIDTHS) {
      const { ctx, page, rpc, console_ } = await boot(browser, { width })
      await shot(page, SEL.toolbar, `perflow-${width}-a`)
      await page.locator(SEL.checks).nth(rowIndex('bike')).check()
      await page.waitForTimeout(2500)
      const before = rpc.length
      await thumb(page, 'bike', 'end').focus()
      for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight')
      await thumb(page, 'bike', 'start').focus()
      for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(3000)
      const after = rpc.slice(before)
      const sliders = await page.getByRole('slider').evaluateAll((els) =>
        els.map((e) => `${e.getAttribute('aria-label')}=${e.getAttribute('aria-valuenow')} @x${Math.round(e.getBoundingClientRect().x)}`))
      const geo = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        iw: window.innerWidth,
        rails: [...document.querySelectorAll('#dashboard div[class*="hourSlider"]')]
          .map((g) => { const r = g.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)] }),
      }))
      await shot(page, SEL.toolbar, `perflow-${width}-b`)
      log(J({
        width,
        hscroll: geo.sw > geo.iw,
        rails: geo.rails,
        sliders,
        rpcAfterBikeMove: [...new Set(after.map((r) => r.fn))],
        migrationRequeried: after.some((r) => r.fn?.includes('living_migration')),
        count: after.length,
        console: console_.filter((c) => c.includes('urban-flow')),
      }, null, 1))
      await ctx.close()
    }
  }

  if (phase === 'bike') {
    const { ctx, page, console_, rpc, failed, pageerrors } = await boot(browser, { width: 1440 })
    await page.locator(SEL.checks).nth(rowIndex('bike')).check()
    log('bike swarm ready after', await waitForSwarm(page, console_, { flow: 'bike' }), 's')
    await shot(page, SEL.canvas, 'bike-on-canvas')
    log('canvas', J(analyze(path.join(OUT, 'bike-on-canvas.png'))))
    await shot(page, SEL.toolbar, 'toolbar-both-flows')
    log('CONSOLE', J(console_.filter((c) => c.includes('urban-flow'))))
    log('RPC', J(rpc.map((r) => `${r.fn} ${r.body}`)))
    log('FAILED', J(failed))
    log('PAGEERRORS', J(pageerrors))
    await ctx.close()
  }

  if (phase === 'tune') {
    // Each preset is a knob set applied to a flat 2D view, screenshotted before
    // and after so the two reads sit side by side.
    const PRESETS = {
      defaults: null, // read the shipped values back instead of setting any
      count: [['count (per flow)', 1500]],
      scatter: [['migration scatter', 0]],
      ramp: [['arrival ramp', 0]],
      trend: [
        ['count (per flow)', 1500], ['glow (halo strength)', 1.5], ['halo size (× dot)', 5],
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
    if (knobs) {
      for (const [label, v] of knobs) await setKnob(page, label, v)
      // A new count rebuilds the layer's GPU buffers (onFinishChange), so give
      // the swarm time to re-form before the second read.
      await page.waitForTimeout(15000)
      await canvas.scrollIntoViewIfNeeded()
      await grab(`${preset}-after`)
    }
    log('knobs', J(await readKnobs(page, [
      'count (per flow)', 'size (px)', 'glow (halo strength)', 'halo size (× dot)',
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
