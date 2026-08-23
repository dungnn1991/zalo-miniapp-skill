> **Tài liệu DEV/lab nội bộ** — ownership, locked interfaces, trạng thái từng phase.
> Người dùng skill đọc [README.md](./README.md); tích hợp chi tiết đọc
> [HUONG-DAN-TICH-HOP.md](./skill/create-zmp-app/HUONG-DAN-TICH-HOP.md).

# Lab `miniapp-bootstrap-poc`

Fast-feedback lab cho SKILL `create-zmp-app` + Mini App POC.
Plan gốc: [`../../26-miniapp-bootstrap-skill-poc-plan-2026-08-20.md`](../../26-miniapp-bootstrap-skill-poc-plan-2026-08-20.md).
Không login, không tạo/deploy app, không nhận credential. `APP_ID` không phải secret; token/cookie là secret.

## Ownership map (implementation round 1)

| Path | Owner | Ghi chú |
|---|---|---|
| `skill/create-zmp-app/config.json`, `skill/create-zmp-app/schemas/`, `skill/create-zmp-app/scripts/browser/runner.mjs` + contract, `scripts/lib/` | **Lead** | LOCKED — subagents không sửa |
| `skill/create-zmp-app/SKILL.md`, `agents/openai.yaml`, `scripts/bootstrap.mjs`, `scripts/portal-fetch.mjs`, `references/portal-routing.md`, `references/app-contract.md` | **Subagent A** | SKILL core + Portal grounding |
| `skill/create-zmp-app/assets/template/` (toàn bộ) | **Subagent B** | Mini App template duy nhất |
| `scripts/install.mjs`, `build.mjs`, `render.mjs`, `verify.mjs`, `record-finding.mjs`, `references/finding-workflow.md`, `evaluation/cases/`, `feedback/` | **Subagent C** | Harness + feedback loop |
| `app/`, `runs/` | generated | Không hand-edit; source là template/scripts |

## Locked interfaces

### Script CLI contract

Mọi script: `node skill/create-zmp-app/scripts/<name>.mjs [--workspace <dir>] [--run-id <id>] ...`

- **Workspace** (chứa `app/`, `runs/`, `feedback/`) mặc định là **cwd** — LUÔN LUÔN, kể cả khi
  chạy từ trong lab (v0.3.1 bỏ heuristic `IN_LAB`: plugin Claude cài nguyên repo nên marker
  `evaluation/cases` luôn khớp và output rơi vào plugin cache). Làm việc trong lab thì truyền
  `--workspace` hoặc env `MB_WORKSPACE` tường minh. Skill assets (config, runner, template,
  `node_modules`) luôn resolve từ vị trí package qua `scripts/lib/paths.mjs`.
- **Exit codes** (khóa trong `skill/create-zmp-app/config.json`): `0` pass · `1` gate fail (đã ghi finding) ·
  `2` needs_input (chưa mutate gì) · `3` precondition/config error.
- Mọi stage append `runs/<run-id>/events.jsonl` qua `lib/run-context.mjs` (allowlist + redact).
  Không log trực tiếp bằng `fs` cho evidence.

### Pipeline (SKILL workflow)

```text
bootstrap → portal-fetch → install → build → render → verify
```

- `bootstrap.mjs --brief <text> [--app-id <id>] [--app-name <n>] [--invoked-via <surface>]
  [--confirm-app-id <id>]`
  — parse + normalize input, App ID resolution theo plan §5.2, scaffold `app/` từ template,
  key-level update `APP_ID` trong `app/.env`, read-back exact-compare.
  Stdout dòng cuối: `{"runId": "...", "status": "ok|needs_input|conflict"}`.
  Viết `runs/<id>/input.json` (input.schema.json) + `evidence/app-id-binding.json`.
  `--confirm-app-id` là đường resolve conflict DUY NHẤT được phép: phải bằng byte-exact prompt
  App ID và chỉ dùng khi user đã chọn rõ; khi đó `.env` được overwrite key-level (không silent —
  có user authorization + event). Mismatch hoặc thiếu prompt ID → exit 3.
  (Bổ sung sau finding_ae4ccee49c2e — conflict resolution loop gap.)
- `portal-fetch.mjs --run-id <id> [--topics <csv>]` — fetch `MA/llms.txt` live, resolve slug theo
  nhu cầu app (getting-started/app-config/zaui/devtools), fetch từng `/docs/MA/....md`, ghi
  `portal-sources.json` `{url, fetchedAt, etag, sha256, status}` với `status` ∈
  `"fetched" | "failed"` (giá trị pin chính thức). Portal chết → exit 1,
  finding `portal_unavailable`, không fallback.
- `install.mjs --run-id <id>` — `pnpm install` trong `app/`, ghi `environment.json`
  (OS, node, pnpm, exact resolved versions, content-hash của skill/template).
- `build.mjs --run-id <id>` — `pnpm exec vite build`, assert artifact trong `dist/`, verify build
  process nhận đúng `APP_ID` (vite `loadEnv` từ app root) và append vào `evidence/app-id-binding.json`
  field `buildProcessAppId`; ghi `evidence/build.log` (redacted).
- `render.mjs --run-id <id>` — serve `app/dist/` bằng node http server (ephemeral port), gọi
  `skill/create-zmp-app/scripts/browser/runner.mjs` (contract: `skill/create-zmp-app/references/browser-runner-contract.md`), copy evidence
  vào `runs/<id>/evidence/`, cleanup server + browser kể cả khi fail.
- `verify.mjs --run-id <id>` — tổng hợp gates từ mọi stage → `result.json` (result.schema.json),
  exit theo status. Mọi gate fail phải có finding trước khi kết thúc.
- `record-finding.mjs` — append/merge theo `fingerprint` vào `feedback/findings.jsonl`
  (finding.schema.json); improvements vào `feedback/improvements.jsonl` (improvement.schema.json).

### Phase 2 pipeline (opt-in — chỉ khi user yêu cầu deploy rõ ràng, sau khi verify pass)

```text
verify (pass) → ensure-login → deploy → verify (re-run với deploy gates)
```

Facts zmp-cli pin ở `skill/create-zmp-app/config.json` mục `zmpCli` (version 4.0.3, observed 2026-08-20). Plan:
[`../../27-miniapp-deploy-phase2-plan-2026-08-20.md`](../../27-miniapp-deploy-phase2-plan-2026-08-20.md).

- `ensure-login.mjs --run-id <id> [--workspace <dir>]` — **key-existence scan** `ZMP_TOKEN`
  trong `app/.env` (tuyệt đối không đọc/parse/log giá trị). Key có → exit 0; nếu `result.json`
  đang `needs_input`/`login_required` thì revert về status tính từ gates (tránh deadlock
  post-login vì deploy đòi status `pass`). Không có key → upsert `result.json`
  `needs_input`/`login_required` (schemaVersion `1.1`), exit 2. Script KHÔNG tự
  spawn `zmp login` — host agent chụp/crop QR và gửi một ảnh cho người quét; không stream raw
  PTY/ANSI redraw qua chat/Remote (contract trong SKILL.md).
  Token hết hạn/thiếu là lifecycle kỳ vọng → **không finding** (đây là quyết định chốt;
  plan 27 §5 control 2 viết "có finding" là wording cũ).
- `deploy.mjs --run-id <id> [--testing] [--desc "<text>"] [--workspace <dir>]` — preconditions: `result.json`
  status `pass`, `appIdBound=true`, `app/dist/index.html` tồn tại, `ZMP_TOKEN` key tồn tại
  (thiếu → exit 2 như ensure-login). Chạy `zmp sync-config dist/index.html` (bắt buộc trước
  deploy `-e` — populate asset lists), rồi spawn lệnh deploy từ `skill/create-zmp-app/config.json`
  (`zmp deploy -p -e -o dist -m "<desc>"`, thêm `-t` khi `--testing`), cwd = `app/`.
  `<desc>` = `--desc` nếu có; default `test <YYYY-MM-DD HH:mm UTC> (<runId>)` — mô tả hiện
  trong Quản lý phiên bản với mode Testing, user có thể truyền mô tả riêng qua prompt.
  Output strip-ANSI + redact → `evidence/deploy.log`. Classify: fail + `authFailureMessage`
  → `needs_input`/`login_required` exit 2 (token hết hạn); fail khác → finding stage `deploy`
  exit 1; success → parse URL scheme `h5.zdn.vn/zapps/` → `evidence/deploy.json`
  (deploy-evidence.schema.json); không parse được URL → finding `deploy_output_unparseable`
  category `dependency`, exit 1 (log vẫn giữ).
- `verify.mjs` khi run có deploy evidence/events: thêm gates `deploy_ok`,
  `deployed_url_recorded`, `no_token_in_evidence` (scan toàn bộ `runs/<id>/` cho JWT-shaped /
  raw `ZMP_TOKEN=` value), `login_not_scripted` (events không chứa `zmp login` kèm `--token`);
  `result.json` dùng schemaVersion `1.1`.
- Token custody: `app/.env` — lab chỉ sở hữu key `APP_ID`; key `ZMP_TOKEN` do zmp-cli sở hữu,
  không đọc/ghi/log giá trị. Cấm agent chạy `zmp login --token ...` dưới mọi hình thức.

### `evidence/app-id-binding.json` (shared A ↔ C)

```json
{
  "sourcePath": "app/.env",
  "sourceType": "prompt|existing_project",
  "expectedAppId": "<string>",
  "persistedAppId": "<read-back từ .env>",
  "buildProcessAppId": "<loadEnv tại build, do build.mjs append>",
  "exactMatch": true
}
```

### Template contract (shared B ↔ A ↔ runner)

- Token thay thế duy nhất: `__APP_NAME__` (xuất hiện trong `app-config.json`, `index.html`).
- Variant data: `assets/template/variants/<variant>/catalog.ts` được bootstrap copy đè lên
  `src/data/catalog.ts`. Variants: `clothing-store`, `neutral` (default trong template = neutral).
  Layout/component dùng chung; variant chỉ đổi copy/dữ liệu mẫu/nav labels.
- 8 marker `data-testid` theo `skill/create-zmp-app/config.json` (`markers`), hiện diện + non-zero size ở mọi
  viewport; `cart-badge` luôn render số nguyên (kể cả `0`); click `add-to-cart` tăng badge đúng 1.
- `.env.example` chỉ có `APP_ID=`; `.gitignore` của template ignore `.env`; runtime `.env` chỉ có `APP_ID`.
- Không khung điện thoại fixed-width giả; mobile-first, reflow hợp lý ở viewport rộng.

### Official templates (opt-in — Phase 2.5)

User không chuyên có thể xin scaffold từ template chính thức của platform. **Không bắt buộc** —
mặc định vẫn là lab template; chỉ kích hoạt khi prompt chứa opt-in phrase (skill/create-zmp-app/config.json
`officialTemplates.optInPhrases`) hoặc `--template official:<id>` explicit.

- Catalog discovery + keyword mapping + support policy + tarball URL pattern:
  `skill/create-zmp-app/config.json` `officialTemplates` (nguồn: github.com/Zalo-MiniApp,
  observed 2026-08-22). Chỉ entry `releaseSupported=true`, `verified=true` và pin commit SHA
  được public route/scaffold. Match theo thứ tự catalog, specific trước generic. Opt-in
  không match support set, hoặc match entry experimental → **exit 3** với stdout JSON cuối
  `{"status":"needs_template_choice","catalog":[...]}` — agent dừng, hỏi user chọn id rồi
  chạy lại với `--template official:<id>`; không tự đoán, không fallback âm thầm.
  (Không đụng needsInput.reason enum của result schema — needs_input dành cho App ID/login.)
- Scaffold: tarball codeload theo `revision` immutable (KHÔNG `zmp init` — interactive treo
  non-tty; KHÔNG git clone),
  strip top dir, set name trong package.json + zmp-cli.json, app title trong app-config.json;
  `.env` APP_ID binding y hệt lab template. `input.json` ghi `template: {source, id, revision}`
  (input.schema.json đã có field optional này; vắng mặt = lab).
- Build: template chính thức có thể có script `build:css` (chạy trước nếu có; **fail →
  finding major category dependency + continue** — vite build mới là gate thật, vì template
  chính thức có thể ship script stale, đã gặp ở zaui-fashion) và outDir `www` thay vì `dist`
  (zmp-vite-plugin default; vite root có thể là `./src`) → build.mjs detect outDir sau build
  (index.html mới nhất trong {dist, www, src/www, src/dist}), ghi `evidence/build-info.json`
  {outDir, builtAt}; render/deploy/sync-config đều theo outDir này (fallback `dist`).
  Template có vite root `./src` mà thiếu `src/index.html` (flow `zmp start/deploy` xử lý nội
  bộ) → build.mjs prep entry hẹp có điều kiện, **mỗi lần prep ghi finding minor** — không
  silent workaround (plan §11).
- Render: oracle profile `official-template` (skill/create-zmp-app/config.json `oracleProfiles`; runner nhận
  `--profile`): mount `#app, #root, [data-testid="app-root"]`, giữ overflow/console/screenshot,
  marker/cta/interaction gates = `skipped` (không fail). Profile suy từ `input.json`
  template.source (official → official-template, else full). Gate `mount_not_empty` (MỌI
  profile): mount có ≥1 child element VÀ body có text — app mount-nhưng-rỗng không được pass
  (plan §8; thêm sau finding_2e7f7967bf09).
- **Host URL contract khi render official template** (bắt buộc — template chính thức dùng
  ZMPRouter production basename `` zapps/${window.APP_ID} ``): render.mjs với profile official
  phải (a) serve outDir dưới path prefix `/zapps/<appId>/` (strip prefix về file, SPA fallback
  giữ nguyên), (b) inject `<script>window.APP_ID="<appId>"</script>` vào index.html LÚC SERVE
  (in-memory, không sửa file build), (c) runner mở URL có prefix. APP_ID không phải secret.
- Deploy: dùng chung contract Phase 2, nhưng vòng này KHÔNG deploy build từ official template
  (dev slot đang giữ bản POC user đã UAT; deploy template app là quyết định riêng của user).

Base URL `https://docs.zaloplatforms.com` — index `/MA/llms.txt`, per-doc `/docs/MA/<slug>.md`
(nguồn: DX file 06/10, verified live 2026-08-20). Không bundle corpus vào skill.

### Simulator provider (Phase 3 — plan 28)

Facts biên SDK↔host pin ở `skill/create-zmp-app/config.json` mục `sdkHostContract` (P3.0 spike
2026-08-21, ground trên npm public). Contract demo tab ở mục `simulatorDemo` (LOCKED, shared
B ↔ C ↔ runner). Quyết định user (plan 28 §2): public-safe, mock tại biên zmp-sdk↔host,
7 API (permission core + identity + login/token), bottomsheet giống thật + badge SIMULATOR.

- **Shim** (C, `scripts/sim/`): define `window.ZaloJavaScriptInterface` mock TRƯỚC bundle app;
  trả lời qua `window.onNativeMessage(serialId, action)(JSON)`; permission store per-API
  (not_determined/granted/denied, localStorage theo appId); GET_SETTING phải nhất quán store
  (SDK pre-check); mock data/error codes từ `references/sim-mock-data.json` (A curate từ
  Portal docs, có nguồn); token mock prefix `SIM_TOKEN_`; sheet có badge SIMULATOR;
  `simDecision` accept|deny|manual từ `__SIM_CONFIG__`; bridge-log POST về `/__sim__/log`
  → `evidence/bridge-log.jsonl`.
- **Serve** (C): profile simulator KHÔNG dùng static server — playwright route-interception
  serve dist tại `https://h5.zdn.vn/zapps/<appId>/` (isMp yêu cầu hostname+path thật), UA
  context mobile Android chứa `Zalo android/<ver>`. Preview simulator = headed Chrome cửa sổ
  thật (playwright channel chrome, headless:false) — chấp nhận deviation "default browser".
- **Template demo tab** (B): navItems keys `home/cart/account`; tab Tài khoản với 4 nút API
  theo `simulatorDemo` markers; API CHỈ gọi khi user bấm (không on-mount — browser profile
  thường không shim vẫn phải pass); deny path hiện error UI thân thiện (errorMarker).
- **Runner** (lead): profile `simulator` = full gates + demo checks ở viewport mặc định
  (accept: result non-empty; deny: error non-empty; badge tồn tại khi sheet từng hiện).
- Mock ≠ native: pass sim không thay UAT Zalo thật; API ngoài registry → fail rõ + finding.

## Chạy

```bash
cd labs/miniapp-bootstrap-poc
S=skill/create-zmp-app/scripts
node $S/bootstrap.mjs --brief "tạo app bán quần áo" --app-id "<id>"   # in ra runId
node $S/portal-fetch.mjs --run-id <id>
node $S/install.mjs --run-id <id>
node $S/build.mjs --run-id <id>
node $S/render.mjs --run-id <id>
node $S/verify.mjs --run-id <id>
```

Negative controls: xem `evaluation/cases/`. Chạy CẢ BỘ case (release gate, cũng là CI):
`npm test` (= validator release + `node evaluation/run-all.mjs`); release mode strict nên
`FAIL` **hoặc** `BLOCKED` đều exit 1. `--allow-blocked` chỉ dùng cho exploratory local,
không được dùng trong CI. Validate skill packaging:
`python3 <skill-creator>/scripts/quick_validate.py skill/create-zmp-app`.

## Trạng thái

- 2026-08-23 — **zaui-coffee đạt render-qualified và được promote** (report 41 N1, mandate 42
  R41-3). Adapter copy nguyên `react-router@^7.6.1` từ zaui-doctor trong khi coffee khai
  `react-router-dom@^6.8.2`, nên cây pnpm có cả 6.30.6 lẫn 7.18.2: build pass, runtime trắng
  trang. Fix tối thiểu là pin `^6.8.2` + thêm precondition `file-contains` khoá đúng range của
  `react-router-dom` để adapter refuse nếu upstream đổi major (không làm cơ chế suy version
  tổng quát khi chưa có regression riêng cho nó).
  Verify: full factory pass đủ 7 blocking gate ở 3 viewport, safe rerun + adapter refusal pass,
  `--promote` áp vào registry. Auto-scaffoldable hôm nay: fashion, coffee, doctor.
  **Hệ quả phải xử lý cùng lúc** (không phải template nào cũng miễn phí khi được promote):
  `official-template-support` từng hardcode zaui-coffee làm "template chưa support" nên xanh-mà-sai
  ngay khi coffee được promote — case giờ chọn probe từ registry lúc chạy. Hai case corpus
  blocking (`ambiguous-do-an-do-uong`, `constraint-mmenu-no-api-url`) đổi kỳ vọng sang `auto`;
  lý do ghi trong `note` của từng case, guard cho đường ra lệnh vẫn nằm ở
  `constraint-mmenu-explicit-no-api-url` (decision=stop).

- 2026-08-23 — **Locked-file change: uncaught-payload capture trong browser runner**
  (report 41 §6.1–6.3, mandate 42 §4.2). Đo thật: playwright làm phẳng một `throw {…}` thành
  `Error("Object")` trước khi tới node, nên `name/message/stack` và `JSON.stringify(err)` đều
  rỗng — hướng fix ghi trong report 41 §6.1 KHÔNG chạy được. Runner giờ serialize payload
  **trong page** (listener `error`/`unhandledrejection` cài trước bundle) và ghi dòng
  `kind="error-detail"` có redaction + size cap; `no_fatal_console_error` vẫn chỉ đếm
  `pageerror` + `console.error` nên verdict của gate không đổi. Kèm: qualification evidence
  lưu `consoleExcerpt` thay vì chỉ số đếm, và gate build phân biệt `preflight_failed` với
  `vite_build` (lucky-wheel từng bị đọc nhầm là lỗi build vì nhãn này).
  Verify: smoke `fixtures/smoke.html` **44/44** exit 0; case mới `pageerror-object-detail`;
  full release gate `33 release checks 33 pass` + `33 cases: 33 pass, 0 blocked, 0 fail`.

- 2026-08-22 — **Candidate v0.3.2:** sửa contract relay QR sau phiên deploy thật qua Codex
  Remote: chụp/crop và gửi một ảnh, không stream raw PTY/spinner/ANSI; agent ngừng poll đến
  khi user báo đã quét. Release validator có gate chống regress về wording cũ; runtime/token
  custody không đổi.
- 2026-08-22 — **Bài học từ deploy qua Codex Remote:** `zmp login` hiện QR gần như tức thì
  trên terminal local, nhưng raw PTY chứa spinner/ANSI redraw bị relay thành hàng nghìn dòng
  lặp và đến điện thoại rất chậm. Contract host-agent đã đổi sang chụp/crop QR thành một ảnh,
  gửi một lần, ngừng poll tới khi user báo đã quét; fallback duy nhất là một khối QR tĩnh đã
  strip ANSI. QR không được lưu vào repo/run evidence và token custody không đổi.

- 2026-08-20 — P0 scaffold + schemas + browser runner LOCKED (smoke 41/41).
- 2026-08-20 — **Implementation round 1 hoàn thành** (P0→P3 của plan; P4 simulator chưa làm):
  - Golden run `run-2026-08-20T10-55-54Z-f08e`: 47/47 gates pass, App ID thật
    `2607885157171557191` bind exact qua prompt → `.env` → build process.
  - `quick_validate` pass; 7 negative controls (§12) + regression case
    `app-id-conflict-resolve` pass; forward-test bằng agent độc lập (chỉ đọc SKILL.md +
    openai.yaml, workspace tạm) pass 46 gates.
  - Finding thật `finding_ae4ccee49c2e` (conflict resolution loop gap) đi trọn lifecycle
    `open → triaged → fixed → verified` (improvement `improvement_d32be6b20bba`, fix
    `--confirm-app-id`); finding `finding_c249aae3bea1` (doc gap `--workspace`) đã fix docs.
  - Limitation: Codex CLI không có trên máy — `$create-zmp-app` được forward-test bằng agent
    khác cùng contract, chưa chạy trong Codex thật. `appName` không suy ra từ brief (dùng
    default; variant catalog quyết định tiêu đề UI) — ghi nhận, chưa coi là lỗi.
- 2026-08-20 — **Phase 2 hoàn thành** (login gate + deploy, plan file 27):
  - Login QR thật qua host-agent relay (3 lần phát QR, lần 3 user quét thành công); token do
    zmp-cli tự lưu vào `app/.env` key `ZMP_TOKEN`, lab chỉ key-existence scan.
  - **Development deploy live**: `https://zalo.me/s/2607885157171557191/?env=DEVELOPMENT&version=zdev-28ad11ae`
    — run `run-2026-08-20T10-55-54Z-f08e`, 51/51 gates (schemaVersion 1.1), UAT checkpoint pass
    (user mở app trong Zalo thật, screenshot khớp browser evidence — `evidence/uat-zalo-checkpoint.json`).
    *Lưu ý version semantics: Development chỉ có MỘT slot — deploy sau đè bản trước, URL này
    luôn trỏ bản dev mới nhất; Testing mới lưu CDN theo version bền (chi tiết:
    `references/deploy-workflow.md` §4).*
  - **Testing deploy version 37**: `https://zalo.me/s/2607885157171557191/?env=TESTING&version=37`
    — run mới `run-2026-08-20T14-04-34Z-ab8a` full pipeline 51/51, desc default
    `test <UTC> (<runId>)`; `--desc` cho mô tả tuỳ chọn.
  - Hai finding thật từ deploy thật đi trọn lifecycle verified: `finding_1d573da3fa61`
    (sync-config bắt buộc trước deploy `-e`) và `finding_42bccd1d5f27` (CLI in URL chỉ dạng QR
    → decode jsqr; scheme thật `zalo.me/s/`). `finding_6ba23dbd9ccc`
    (zmp-cli tắt TLS verification) triaged route-only cho zmp-cli owner.
  - Case suite: 15 cases pass (8 Phase 1 + conflict-resolve + 4 Phase 2 + deploy-qr-parse + golden).
  - Chưa làm: simulator adapter (P4 plan 26); production release ngoài scope.
- 2026-08-20 — **Phase 2.5 hoàn thành: option official templates (opt-in)**:
  - Discovery catalog ghi 11 repo github.com/Zalo-MiniApp; release support là tập con riêng.
    Từ candidate v0.3.1 chỉ `zaui-fashion` được support, pin commit SHA và E2E;
    entry experimental dừng trước fetch. Mặc định vẫn lab template; mơ hồ →
    `needs_template_choice` (exit 3), không đoán/fallback.
  - E2E thật với `zaui-fashion` (case `official-template-golden`): scaffold → install → build
    (build:css tolerant + prep entry có finding + outDir detect `src/www`) → render profile
    `official-template` với host URL contract (`/zapps/<appId>/` + inject `window.APP_ID`)
    → **UI thật render** (logo, carousel, category, bottom nav VI); data-driven areas ở
    skeleton vì cần `zmp-sdk` host bridge — giới hạn browser đã biết, không nới gate.
  - Gate mới mọi profile: `mount_not_empty` — bịt gap oracle từng cho trang blank pass
    (finding_2e7f7967bf09, verified). Golden Phase 1 giờ 50 gates, hành vi không đổi.
  - 3 finding upstream route-only cho template/CLI owner: build:css stale (zaui-fashion),
    plain-vite-build gap (vite root src không có src/index.html), TLS off (zmp-cli).
  - Không auto-deploy build từ official template — quyết định riêng của user khi cần.
- 2026-08-21 — **Phase 2.6 hoàn thành: quality insight + packaging** (plan 29):
  - Package tự chứa tại `skill/create-zmp-app/` (config.json + schemas/ + browser runner +
    package.json riêng); paths.mjs nhận biết lab vs shipped (workspace = cwd khi standalone).
  - **Single entry `scripts/run.mjs`** chain toàn pipeline (kể cả deploy/preview opt-in);
    `preview.mjs` mở browser mặc định. Agent chạy ngầm, user không gõ lệnh tay.
  - 8 preflight gates (size limit 10/3MB fail, server-side-API scan fail-blocking, asset-path
    warn, CORS source scan passive warn; OPTIONS live chỉ opt-in bằng
    `MB_ENABLE_CORS_PROBE=1`, permission-registry hint, Checkout-SDK hint,
    ZMP_TOKEN env trap, quota parse); gate `warn` không fail run; insight vào `result.insights[]`.
  - Tier-2: `references/error-signatures.json` (11 chữ ký từ community FAQ, có nguồn) +
    matcher đính `insight` vào finding khi log khớp. References mới: `troubleshooting.md`,
    `operations.md` (chưng cất từ `DX/community-faq-best-practice/`, attribution đầy đủ).
  - Case suite: 22 cases pass (6 mới Phase 2.6); golden = 55 pass + 1 warn checkout (kỳ vọng).
  - **Shipped**: cài thật vào `~/.claude/skills/create-zmp-app/` (14MB gồm node_modules);
    standalone smoke pass; forward-test ship dry-run bằng agent mới chỉ thấy package.
- 2026-08-21 — **Phase 3 hoàn thành: simulator/mock host** (plan 28):
  - P3.0 spike map trọn biên SDK↔host từ npm public (pin `config.json sdkHostContract`):
    injection `window.ZaloJavaScriptInterface`, callback `window.onNativeMessage`, isMp đòi
    serve interception tại `h5.zdn.vn/zapps/<id>` + UA Zalo Android; SDK auto-login on load;
    **3/4 demo API đi HTTPS openapi (fetch-patch), không phải jsCall**; `ZJSBridge` stub bắt buộc.
  - Shim self-contained trong package (`scripts/sim/`): permission store 3 trạng thái,
    bottomsheet giống thật + badge SIMULATOR, mock data/error codes thật từ Portal docs
    (`references/sim-mock-data.json`: -201 user-deny, -1401 unauthorized; persona giả),
    token `SIM_TOKEN_*`, unmocked API fail rõ, bridge-log evidence.
  - Template tab "Tài khoản" (4 nút API, chỉ gọi khi click; guard unhandledrejection cho
    SDK auto-login); runner profile `simulator` (demo checks accept/deny/manual, respect
    requiresPermission per registry); preview `--sim` = headed Chrome window.
  - `run.mjs` flags `--verify-sim`/`--preview-sim`/`--sim-decision` + **doctor tự setup**
    (Node/Chrome check, tự pnpm/npm install deps khi thiếu — máy mới chỉ cần copy folder).
  - Lead E2E manual mode: 65 gates pass, bridge-log 7 entries. Cases: 28 tổng (6 sim mới +
    doctor-autoinstall). Finding runner gap `requiresPermission` verified qua re-run.
  - Trung thực: mock ≠ native — pass sim không thay UAT Zalo thật (FAQ 21); API `login`
    không có Portal doc (mock ít doc-backed nhất, đã flag).
- 2026-08-22 — **v0.3.1 release-hardening** (`8ab2510`, tag `v0.3.1`):
  - 3 P0 từ audit install/rerun/workspace được phủ regression; canonical plugin chỉ còn
    một skill path; root `.env` bỏ tracking và ignore mọi cấp.
  - Official template public support khoá ở `zaui-fashion` pin SHA; 10 entry còn lại
    experimental và dừng trước network/mutation.
  - `npm test` gồm release metadata validator + 32 behavioral case, strict với `BLOCKED`;
    CI exposes context `release-gate`. Ruleset chỉ có thể require context này sau khi
    workflow được commit/push và chạy lần đầu.
  - Verification local trên base `43ad3ee` + working tree candidate: hai full-suite run đều
    `32/32 pass, 0 blocked`; release validator `27/27`; skill-creator quick validator và
    Claude marketplace/plugin manifest validator pass. E2E từ bản cài Codex và Claude
    plugin-cache cô lập đều pass `54 gate + 2 policy warning` (không deploy).
  - Còn hai release decision không tự chốt trong source: owner chọn license cho repo public
    (finding_38a04a6460d6), và sau push gắn required status check vào ruleset
    (finding_3768b1ae9aab). Deploy còn known upstream risk zmp-cli 4.0.3 tắt TLS verify
    (finding_6ba23dbd9ccc), đã nêu công khai trong README.
