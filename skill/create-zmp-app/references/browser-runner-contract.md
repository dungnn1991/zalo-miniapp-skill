# Browser render oracle — locked contract

**Owner:** integration lead. Subagents call the runner; they do not edit it.
**Status:** LOCKED 2026-08-20 — smoke-verified against `fixtures/smoke.html` (41/41 gates, exit 0).

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
| `console.jsonl` | One line per console/pageerror event: `{viewport, kind, type, text, url, at}` |
| `dom.json` | Per-viewport marker boxes, route, `scrollWidth`/`innerWidth` |
| `gates.json` | `{gates: [{id, status: pass|fail, detail, viewport}]}` — consumed by `verify.mjs` |
| `<viewport>.png` | Screenshot per viewport with `screenshot: true`, **initial state** (taken before the interaction check) |

## Gates per viewport

- `react_mount` — `markers.appRoot` attached within 15 s.
- `marker_<key>` — each marker present with non-zero bounding box (first element).
- `no_horizontal_overflow` — `scrollWidth <= innerWidth + 1`.
- `cta_not_clipped` — first `addToCart` box fully inside viewport width.
- `screenshot` — file written.
- `interaction_add_to_cart` — only on `interactionCheck.runOnViewports`: click first `addToCart`,
  `cartBadge` integer text increments by exactly 1.
- `no_fatal_console_error` — zero `pageerror` + zero `console.error`. Exception: a
  `favicon.ico` "Failed to load resource" 404 is logged but not fatal.

## Exit codes

`0` all gates pass · `1` ≥1 gate failed (evidence still fully written) · `3` runner/launch error.

## Template obligations implied by this oracle

- All eight `data-testid` markers from `config.json` exist and are visibly sized at every viewport.
- `cart-badge` always renders an integer (including `0`).
- Clicking any `add-to-cart` increments the badge by 1.
