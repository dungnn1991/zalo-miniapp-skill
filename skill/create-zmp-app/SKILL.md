---
name: create-zmp-app
description: Bootstrap a small Zalo Mini App demo from a natural-language brief plus a user-supplied Mini App ID — scaffold the deterministic clothing/neutral lab shell or a release-supported official template, bind APP_ID exactly, ground on live Portal Markdown, install, build, then render-verify in a browser with evidence; on explicit request, deploy the verified build to Development/Testing via zmp-cli with a user-scanned QR login. Brief hiểu cả tiếng Anh và tiếng Việt có dấu lẫn không dấu ("tao app ban quan ao", "create a clothing store app"). Trigger on requests like "tạo Zalo Mini App", "tạo app bán quần áo", "tạo mini app", "bootstrap mini app", "scaffold zmp app", "create a zalo mini app", "deploy mini app lên development/testing". Do NOT trigger for knowledge-only questions about Zalo Mini App, for provisioning/app-creation or production-release requests, or when intent is ambiguous — never scaffold or deploy without a clear request.
---

# create-zmp-app

Bootstrap a small Zalo Mini App demo from a brief + Mini App ID, then prove it renders.
The bundled lab template selects clothing-store or neutral demo data; it does not generate an
arbitrary domain UI. The mechanics stay deterministic. Everything below routes to
locked contracts — facts live in `config.json`, `schemas/`, and `references/`, all inside this
self-contained skill package.

## Guardrails (hard stops)

- **Never** provision or create a Zalo App/Mini App, and never accept or request credentials.
  Login/deploy are allowed **only** through the opt-in Phase 2 flow below — explicitly requested
  by the user, token owned end-to-end by zmp-cli. `ZMP_TOKEN`/cookies/tokens are secrets and
  must never appear in prompt, argv, logs, or evidence. `APP_ID` is **not** a secret.
- **Never invent, guess, or transform an App ID.** It is a string, exact-preserved (leading
  zeros kept, never numeric-cast). The only sources are the user's prompt and the project's
  `app/.env`.
- Any script exiting `2` means **STOP and ask the user**. Do not proceed, retry with a made-up
  value, or overwrite files to "fix" it.
- CORS inspection is passive by default. Do not set `MB_ENABLE_CORS_PROBE=1` unless the user
  has authorized live requests to the app's API origins; a live probe never replaces Zalo UAT.
- Knowledge-only or ambiguous intent → answer the question; do not scaffold.

## No improvisation (hard rules)

The pipeline is the product — do not re-create it by hand:

- Use **only** `run.mjs` with the flags documented here (per-stage scripts only for
  debugging, per "Advanced"). **Never** hand-write your own scaffold/build/deploy commands
  (`npm create`, `zmp init`, raw `vite build`, raw `zmp deploy`, ...) in place of the
  pipeline.
- **Never** edit the generated app's code on your own initiative — only when the user asks
  for a specific change.
- **Never** skip, reinterpret, or "work around" the exit-code contract. Exit `2`/`3` means
  stop and surface — not find another way through.
- **Never** substitute your own App ID, app name, template choice, or any other value the
  contract says comes from the user or config.
- Anything outside the documented flows → **stop and tell the user** what happened; do not
  invent a workaround.

## Input contract

Normalized input is written to `runs/<run-id>/input.json` and must conform to
`schemas/input.schema.json` (in this package; `additionalProperties: false`). Key fields:
`brief` (null → neutral demo shell, no extra questions), `miniAppId` (required string),
`appIdSource`, `appName`, `variant`, `renderProvider`, `defaultViewport`, `packageManager`,
`invokedVia`, and optional `template` provenance (`source`, `id`, immutable `revision` for an
official template). Defaults come from `config.json` so a short prompt still runs. The brief is
stored exactly as the user gave it — when `--app-id` is absent, an embedded `appId=`/`miniAppId=`
value is extracted from it as the prompt App ID, but it is never stripped from the stored brief.

## App ID resolution (exact order — plan §5.2)

1. If the prompt has `appId`/`miniAppId` (flag or embedded in the brief), that value is
   `expectedAppId`.
2. Else, if `app/.env` exists, read its `APP_ID` (key-level parse; quotes/whitespace tolerated,
   value exact-preserved).
3. Both present and **equal** → continue (`appIdSource=prompt`).
4. Both present and **different** → conflict: stop **before any mutation**, record finding
   `app_id_conflict`, exit `2`, and ask the user which ID to keep. Never overwrite silently —
   the only sanctioned overwrite is re-running with `--confirm-app-id` after the user
   explicitly chose the prompt ID (see needs_input handling).
5. Neither present → `needs_input`: exit `2` and ask the user for the Mini App ID they created
   on Zalo Developers. No scaffold, no install, no build until it is supplied.

After binding, `APP_ID` is written into `app/.env` by key-level upsert, read back, and
exact-compared; a mismatch is a hard fail (`app_id_not_persisted`).

## Golden workflow — one command

Run the whole pipeline through the **single entry** (from the skill directory):

```bash
node scripts/run.mjs --brief "tạo app bán quần áo" [--app-id <id>] \
  [--existing | --force-scaffold] [--invoked-via <surface>] \
  [--deploy | --deploy-testing] [--preview] [--preview-timeout <ms>] \
  [--verify-sim] [--preview-sim] [--sim-decision accept|deny|manual] [--workspace <dir>]
```

`run.mjs` chains bootstrap → portal-fetch → install → build (+preflight gates) → render →
verify (+insights) [→ ensure-login → deploy → verify] [→ preview], stops exactly where the
exit-code contract says, and prints a final JSON status line for you to read.

**Agent conduct — the user's whole UX is the prompt:**

- **Run the command yourself.** Never tell the user to run commands, never paste raw
  logs at them, never hand them a "next steps: run X" list.
- **Stop and ask the user** at exactly **four points**: (1) missing/conflicting App ID, or an
  existing modified app (`existing_app` — user chooses `--existing` vs `--force-scaffold`) ·
  (2) official-template choice when ambiguous or the requested template is not release-supported · (3) QR scan for login ·
  (4) confirmation before deploy. Everything else runs unattended — no other questions;
  the milestone narration below is one-way status, not a stop.
- **Preview by default.** For a create request, always include `--preview` so the user gets
  the built app opened for review the moment verify passes — or `--preview-sim` instead when
  their prompt mentions giả lập/simulator/thử quyền. Skip the preview flag only when the user
  explicitly says they don't need to see it ("không cần xem").
- **Narrate progress at milestones — never go silent, never dump raw logs:**
  - at start: one line on what you are about to do;
  - after verify: the result, and that the preview is opening;
  - at **every** exit `2`/`3` stop: why it stopped and exactly what the user must do next
    (use the question from `result.json` / the printed catalog verbatim);
  - after deploy: the deployed URL plus the version-semantics caveat (Development = one
    overwritten slot; Testing = durable CDN version).
- **Final report must include:** the open preview URL (`http://127.0.0.1:<port>...`), the app
  path + evidence paths (`runs/<runId>/evidence/...`, screenshots, `result.json`), any
  `insights` the pipeline attached, the deployed URL if a deploy ran, and one or two
  **suggested next steps** (e.g. "muốn deploy thử, nói 'deploy bản development'"; "muốn thử
  flow xin quyền, nói 'chạy giả lập'").

`run.mjs` and every per-stage script accept `--workspace <dir>` to redirect the generated
output — `app/`, `runs/`, `feedback/`. **Warning:** all stages of one run must receive the
**same** `--workspace` (or set `MB_WORKSPACE` once). Default: the **current working
directory**, always — the package location (plugin cache, `~/.codex/skills`, dev lab) never
decides where output lands. The dev lab redirects explicitly with `--workspace`/`MB_WORKSPACE`.

**Safe rerun (never lose user code):** scaffolding records a manifest
(`app/.scaffold-manifest.json`) of exactly the files it wrote. Re-running a create command
stops with exit `2` (`existing_app`) before touching anything when the app was edited since
scaffold, was not created by the skill, resolves to a **different template** than it was
scaffolded from, or when the incoming template would overwrite a file the manifest does not
own. Resume with `--existing` (keep the code, bind + build + verify only) or
`--force-scaffold` (explicit user-authorized overwrite). An untouched same-template app
re-scaffolds silently (idempotent retry); files the user added are never absorbed into the
manifest and never block a rerun.

**Exit codes** (locked in `config.json`):

| Code | Meaning | What you do |
|---|---|---|
| `0` | pass | done — report the result |
| `1` | gate fail (finding recorded) | stop; read `insights`/findings + `runs/<runId>/`; report honestly |
| `2` | needs_input (nothing mutated) | **stop and ask the user** (see below) |
| `3` | precondition/config error | stop; fix environment/invocation, do not touch locked files |

> **Exception on exit `3`:** final-line status `needs_template_choice` (ambiguous or
> unsupported official template) also uses exit `3` but is an **ASK-USER** stop, not an
> environment error: stop, list the printed release-supported catalog for the user to choose,
> then re-run with
> `--template official:<id>`. (Design note: exit `3` was chosen so the `needsInput.reason`
> enum stays reserved for App ID/login.)

### Advanced: per-stage scripts (debug/regression only)

The stages behind `run.mjs` — same contracts, same flags; users never need these:

```bash
S=scripts
node $S/bootstrap.mjs --brief "..." [--app-id <id>] [--template official:<id>] [--confirm-app-id <id>]
node $S/portal-fetch.mjs --run-id <runId>
node $S/install.mjs --run-id <runId>
node $S/build.mjs --run-id <runId>
node $S/render.mjs --run-id <runId>
node $S/verify.mjs --run-id <runId>
node $S/ensure-login.mjs --run-id <runId>                            # deploy opt-in from here
node $S/deploy.mjs --run-id <runId> [--testing] [--desc "<text>"]
node $S/verify.mjs --run-id <runId>
```

## When something fails

1. **Read `insights` first**: build/deploy/verify auto-match their logs against the error
   signature map and attach `{diagnosis, fix, source}` to `result.json`/findings.
2. No insight attached? Match the error text yourself against
   `references/error-signatures.json` (compile each `pattern` with its `flags`; first match
   wins; entries carry diagnosis, concrete fix, and the community source URL).
3. For the full write-up: `references/troubleshooting.md` (dev/build/deploy errors — CORS,
   ES2015, www/outDir, CI/CD login, asset paths, size limits) or `references/operations.md`
   (Live debugging with `zDebug=true`, device mode, roles/version semantics, review policy).
4. Nothing matches → report honestly with the log evidence. **Do not guess.**

## Official templates (opt-in)

**Never mandatory** — the default is always the lab template (a deterministic demo shell,
not an arbitrary-domain UI generator); the user can ask the agent to integrate features on
that shell. Activate official routing only when the user
explicitly asks for a ready-made template ("dùng mẫu có sẵn", "template chính thức", "tạo
nhanh từ template chính thức") or passes `--template official:<id>`. Catalog, opt-in phrases
and keyword mapping are locked in `config.json` `officialTemplates`. Only entries with
`releaseSupported=true` are exposed; `verified` is evidence, not the support decision.

- Opt-in phrase in the brief → bootstrap maps it to a catalog id by keywords, in catalog
  order (first match wins). Explicit `--template official:<id>` wins routing, but cannot bypass
  `releaseSupported`.
- Opt-in with no supported keyword match, or a known but unsupported id → bootstrap exits `3`
  **before fetch/app mutation** with a final stdout JSON
  `{"status":"needs_template_choice","catalog":[...]}` — **stop and ask the user to pick an
  id from that release-supported catalog**, or remove the template request to use the lab
  template. Never guess, never fall back silently.
- Release-supported official templates are fetched at the immutable `revision` in config;
  `input.json` and the scaffold manifest preserve that revision.
- APP_ID resolution/binding, `input.json`, and the rest of the pipeline are identical; render
  runs the `official-template` oracle profile (lab marker/interaction/CTA gates report
  `skipped` — official templates have no lab `data-testid` markers). Deploy is **not**
  automatic for official-template builds in this round.
- Example: `$create-zmp-app tạo app thời trang dùng mẫu zaui-fashion với appId="..."`.
- Details: `references/official-templates.md`.

## Simulator (Phase 3, opt-in)

Use when the user wants to **see the app and try the permission flows without Zalo** — asks
like "chạy thử", "giả lập", "preview API", "thử flow xin quyền". Two modes via `run.mjs`
flags (`--preview-sim` to open a headed Chrome window for hands-on preview, `--verify-sim`
to run the pipeline with the simulator render profile), plus
`--sim-decision accept|deny|manual` (**default `accept`**) controlling the fake consent
sheets:

- **Verifying the permission flows fully = run `accept` AND `deny`** (result markers on
  accept, error markers on deny).
- Want bottomsheet + badge evidence — gate `sim_sheet_badge` and screenshots
  `sim-sheet-<api>.png`? Run an extra pass with `--sim-decision manual`. In `accept`/`deny`
  the sheet auto-resolves **before it is shown**, so those modes have no badge gate —
  by design, not a bug.

- The simulator mocks the zmp-sdk↔host boundary with curated data
  (`references/sim-mock-data.json`, grounded on Portal docs). Consent bottomsheets carry a
  **SIMULATOR badge — that consent is fake** (auto or clicked by the viewer), never a real
  user's consent.
- Be honest in reports: **mock ≠ native; passing sim never replaces UAT in real Zalo**; mock
  tokens (`SIM_TOKEN_*`) cannot be decoded for real; APIs outside the mock registry fail
  loudly by design.
- The **four user-surfacing points do not change**; sim needs no extra questions.
- Details + limits: `references/simulator-workflow.md`.

## Feature integration (khi user yêu cầu tính năng cụ thể)

Khi user yêu cầu rõ ("tích hợp đăng nhập user Zalo vào nút X", "thêm chức năng Y"), bạn ĐƯỢC
sửa code app đã sinh — đây là ngoại lệ hợp lệ của rule "không sửa app". Quy trình bắt buộc:

1. Mở `references/feature-recipes.md` — tính năng có recipe (vd đăng nhập/lấy user info:
   getSetting → authorize → getUserInfo → cache storage) thì theo ĐÚNG recipe, không tự chế
   pattern khác. Chưa có recipe → fetch Portal docs của API liên quan trước, làm theo docs,
   ghi nguồn vào code comment.
2. Sau khi sửa: chạy lại build + verify qua `run.mjs` **với `--existing`** — bắt buộc, vì
   không có nó pipeline sẽ dừng ở `existing_app` (và `--force-scaffold` sẽ XÓA code vừa
   tích hợp). Rồi mở preview cho user — flow liên quan quyền thì dùng simulator
   (`--preview-sim`, hoặc `preview.mjs --sim` với app official) để user tự bấm thử; nhớ ranh
   giới: form quyền thật chỉ có khi app LIVE.
3. Báo cáo: đã đổi file nào, theo recipe/nguồn nào, kết quả verify, bước tiếp theo.

## Deploy (Phase 2, opt-in)

Deploy runs **only** when the user explicitly asks for it ("deploy", "đưa lên
development/testing") **and** the current run's `verify` passed — and you confirm with the
user before deploying (surfacing point 4). **Never auto-deploy after verify.** Pinned zmp-cli
facts (version, commands, error codes) live in `config.json` `zmpCli`; details in
`references/deploy-workflow.md`.

Preferred: pass `--deploy` (Development) or `--deploy-testing` (Testing — explicit user
request only) to `run.mjs`; it chains ensure-login → deploy → verify and stops on the same
contract. Per-stage equivalents are in the Advanced section above.

The exit-code table above applies unchanged (`2` = needs_input / `login_required` → stop and
ask the user before doing anything else).

**Version description.** If the user's deploy request includes a description (e.g. `deploy
testing với mô tả "bản demo sprint 3"`), pass it as `--desc "<text>"`. If it doesn't, do
**not** ask for one — `deploy.mjs` defaults to `test <YYYY-MM-DD HH:mm UTC> (<runId>)`.

**Login (QR relay).** If `ensure-login` exits `2`:

1. Spawn `zmp login` interactively with cwd `app/` (the host agent runs it — the script never
   does; `APP_ID` is already bound in `app/.env`).
2. **Relay the QR output verbatim** to the user to scan with the Zalo app. The window is
   ~2 minutes (the CLI polls login status by itself; the agent never touches or reads the auth
   response). On timeout, ask the user whether to show a fresh QR — no silent retry loop.
3. Wait for the CLI's "Login Success!", then re-run `ensure-login` to confirm. Confirmation is
   **key-existence only** — NEVER confirm by reading the `ZMP_TOKEN` value.

**Deploy guardrails (hard stops)**

- **Never** run `zmp login --token ...` or pass a token via argv/prompt in any form.
- **Never** read or echo the value of `ZMP_TOKEN` — key-existence checks only.
- `--testing` only when the user explicitly names the Testing build; default is Development.
- A deploy failure containing "Permission denied. Please login again." means the token expired
  → go back to the login step above; do not retry blindly.

## needs_input handling

If the pipeline exits `2`: read `runs/<runId>/result.json` → `needsInput.question`, ask the
user exactly that (missing App ID, or which ID to keep on conflict), and wait. Then resume by
re-running the same `run.mjs` command with the extra flag:

- **Missing App ID** — re-run with the user's answer as `--app-id`.
- **Conflict, user chooses the prompt ID** — re-run with `--app-id <id> --confirm-app-id <id>`
  (same value, byte-for-byte). `--confirm-app-id` is the user's explicit authorization for
  bootstrap to overwrite the conflicting `app/.env` value (key-level upsert, still read-back
  verified). Never pass it unless the user has explicitly chosen that ID after being asked —
  never preemptively, never to "avoid" the question.
- **Conflict, user chooses the project ID** — re-run without any prompt App ID (drop `--app-id`
  and any `appId=` embedded in the brief); the existing `.env` value is reused unchanged.
- **`existing_app`** — the workspace already holds an app with user-edited (or foreign) files.
  Ask which way to go, then re-run with `--existing` (keep the code) or `--force-scaffold`
  (user-authorized overwrite). Never pick for the user, never force-scaffold to "unblock".

Never proceed past exit `2`, never invent an ID, never edit `app/.env` by hand to bypass a
conflict.

## Invocation surfaces

`/create-zmp-app ...` (slash-command hosts), `$create-zmp-app ...` (Codex-style hosts —
`agents/openai.yaml` carries UI metadata only; the contract is this file), or natural language
("Dùng create-zmp-app tạo app ..."). All surfaces map to the **same** input schema and
workflow — adapters translate invocation syntax only and must not fork the workflow,
guardrails, or gates. Pass the surface via `--invoked-via
slash-command|codex-skill|natural-language|harness`.

## Example prompts

- `/create-zmp-app tạo app bán quần áo với appId="37853..."`
- `$create-zmp-app tạo app bán quần áo với appId="37853..."`
- `Dùng create-zmp-app tạo app bán quần áo, miniAppId=001234567890`
- `tao app thoi trang dung mau zaui-fashion, appId=...` (không dấu — brief VN có dấu/không dấu/EN đều hiểu)
- `/create-zmp-app scaffold a clothing store mini app, appId=37853...`
- `app đang lỗi Network Error, check giúp` → no re-scaffold: match the error against
  `references/error-signatures.json` (here: CORS entry — fix is on the **server**), then walk
  the user through the fix from `references/troubleshooting.md`.
- Negative (do **not** scaffold): "Zalo Mini App là gì?", "so sánh zmp-ui với antd",
  "app bán quần áo nên có tính năng gì?" (no create intent).

## References

- `references/feature-recipes.md` — recipe tích hợp tính năng theo chuẩn Portal (đăng nhập user Zalo...).
- `references/portal-routing.md` — how live Portal docs are discovered/routed; no-bundle,
  no-fallback policy; `portal-sources.json` shape.
- `references/app-contract.md` — the 8 `data-testid` markers, `__APP_NAME__` token, variants,
  `.env` rules, responsive rules, zmp-ui component surface.
- `references/deploy-workflow.md` — Phase 2 login gate + deploy: pinned zmp-cli contract, token
  custody, QR relay steps, error classification, deploy evidence, manual UAT checkpoint.
- `references/official-templates.md` — Phase 2.5 official-template scaffold: catalog routing,
  tarball mechanics, what does not apply (markers/variants/token), build/render differences.
- `references/error-signatures.json` — regex signature map: known error → diagnosis, concrete
  fix, community source URL. First stop for any unrecognized log line.
- `references/troubleshooting.md` — curated dev/build/deploy errors (CORS, ES2015, www/outDir,
  CI/CD login traps, asset paths on CDN, size limits, no-data-when-dev) with sources.
- `references/operations.md` — Live debugging (`zDebug=true`), device mode, store visibility,
  Checkout SDK policy, permission registry, server-side-only APIs, Dev/Testing/Live semantics.
- `references/browser-runner-contract.md` — render oracle contract (gates, evidence files,
  oracle profiles).
- `references/simulator-workflow.md` — Phase 3 simulator: verify/preview behavior, headed
  Chrome deviation, simDecision modes, honest limits (mock vs real Zalo).
- `references/sim-mock-data.json` — mock persona + per-API success/deny data for the sim
  shim, curated from live Portal docs (docSource per API).
- `config.json` — authoritative markers, viewports, variants, official-template catalog,
  dependency policy, zmp-cli facts, exit codes.
