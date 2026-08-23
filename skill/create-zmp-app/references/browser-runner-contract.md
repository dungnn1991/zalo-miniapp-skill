# Browser render oracle — locked contract

**Owner:** integration lead. Subagents call the runner; they do not edit it.
**Status:** LOCKED 2026-08-20 · last locked-file change 2026-08-23 (uncaught-payload capture
report 41 §6.1, and the `simulator-official` profile + runtime-marker gates, mandate 42 §3.2–3.3)
— smoke-verified against `fixtures/smoke.html` (**47/47** gates, exit 0) and against
`fixtures/throw-object.html` via case `pageerror-object-detail`.

## Invocation

```bash
node scripts/browser/runner.mjs --url <http-url> --out <evidence-dir> [--config <config.json>]
```

- Browser: system Chrome via `playwright-core` (`channel: "chrome"`, headless). No browser download.
- Viewports, marker selectors and the interaction check come from `config.json` — the single
  source of truth shared with the template. Do not duplicate selectors elsewhere.

## Outputs (into `--out`)

| File | Content |
|---|---|
| `console.jsonl` | One line per console/pageerror event: `{viewport, kind, type, text, url, at}`, plus `kind: "error-detail"` companion lines (see below) |
| `dom.json` | Per-viewport marker boxes, route, `scrollWidth`/`innerWidth` |
| `gates.json` | `{gates: [{id, status: pass|fail, detail, viewport}]}` — consumed by `verify.mjs` |
| `<viewport>.png` | Screenshot per viewport with `screenshot: true`, **initial state** (taken before the interaction check) |

## Oracle profiles

Three independent axes, deliberately not one flag — `config.json` `oracleProfiles` is the
source of truth:

| Profile | sim serving | lab markers (8 `data-testid` + cta + interaction) | sim demo-flow |
|---|---|---|---|
| `full` (default) | no | yes | — |
| `official-template` | no | no | — |
| `simulator` | yes | yes | yes |
| `simulator-official` | yes | no | no |

`--profile simulator*` requires `--sim-manifest <path>` instead of `--url`; the app is served
by route interception at `https://h5.zdn.vn/zapps/<appId>/`.

## Gates per viewport

- `react_mount` — `markers.appRoot` attached within 15 s.
- `marker_<key>` — each marker present with non-zero bounding box (first element).
- `no_horizontal_overflow` — `scrollWidth <= innerWidth + 1`.
- `cta_not_clipped` — first `addToCart` box fully inside viewport width.
- `screenshot` — file written.
- `interaction_add_to_cart` — only on `interactionCheck.runOnViewports`: click first `addToCart`,
  `cartBadge` integer text increments by exactly 1.
- `no_fatal_console_error` — zero `pageerror` + zero `console.error`. Exception: a
  `favicon.ico` "Failed to load resource" 404 is logged but not fatal. **Unchanged by the
  simulator profiles**: nothing is downgraded to a warning, the app is simply run in the
  environment it is written for.
- `sim_runtime_marker` (sim serving only) — `window.__ZMP_DX_RUNTIME__` present with
  `schemaVersion === 1` and `mode === "simulator"`.
- `no_sim_runtime_marker` (every other profile) — that marker must be **absent**. The
  simulator serves from the real hostname and path, so the marker is the only thing separating
  simulator from production; a leaked marker would let a template hand out mock data inside a
  real host. Both directions are covered by `evaluation/cases/sim-runtime-marker`.

## Uncaught-payload capture (`kind: "error-detail"`)

Playwright rebuilds the page's error before node sees it, and a thrown **non-Error** is
flattened on the way: `throw {code:-2000, detail:{…}}` arrives as `name="" message="Object"
stack=""`, so `String(err)`, the individual fields and `JSON.stringify(err)` all yield nothing
usable. That is why `zaui-market`'s evidence read literally `"Object"` and the template stayed
undiagnosable (report 41 §6.1).

The runner therefore also serializes the value **in the page**, from a `window` `error` /
`unhandledrejection` listener installed by an init script before the app bundle, and ships it
out through an exposed function:

```json
{"viewport":"mobile-390x844","kind":"error-detail","source":"window.onerror",
 "valueType":"object","isError":false,"text":"{\"code\":-2000,\"detail\":{…}}","at":"…"}
```

- `source` — `window.onerror` or `unhandledrejection`.
- `text` — JSON of the serialized value; Errors keep `name`/`message`/`stack`. Bounded in the
  page (depth 4, 30 keys, 20 array items, 500 chars per string) and again in node
  (4000 chars per record, 25 records per viewport), then passed through `lib/redact.mjs`.
- Resource-load failures are skipped — they fire a payload-less `Event`, and `page.on('console')`
  already records them.
- **These lines are evidence only.** `no_fatal_console_error` still counts `pageerror` +
  `console.error` and nothing else, so the gate's verdict is byte-for-byte what it was before.
- Regression: `evaluation/cases/pageerror-object-detail` (fixture
  `evaluation/browser/fixtures/throw-object.html`) asserts the nested payload survives on every
  viewport while the fatal count stays at the number of `pageerror` events.

## Exit codes

`0` all gates pass · `1` ≥1 gate failed (evidence still fully written) · `3` runner/launch error.

## Template obligations implied by this oracle

- All eight `data-testid` markers from `config.json` exist and are visibly sized at every viewport.
- `cart-badge` always renders an integer (including `0`).
- Clicking any `add-to-cart` increments the badge by 1.
