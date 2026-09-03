# Changelog — create-zmp-app

Mọi thay đổi đáng kể của skill. Version = `package.json` + git tag `vX.Y.Z` trên nhánh `main`.
Thay đổi phát sinh từ finding formal phải gắn id; expected/actual/lifecycle nằm trong
`feedback/findings.jsonl`, decision và regression nằm trong `feedback/improvements.jsonl`.

## [Unreleased] — 2026-08-24

### Changed — Checkout V1.1 planning/guardrail

- Thêm contract environment tri-state: non-Zalo/simulator dùng mock có nhãn; Zalo-ready dùng
  native Checkout; Zalo-blocked/unknown hiển thị toast + inline error và không fallback mock.
- Deprecate việc dùng custom `demo-cod` Development như bằng chứng native Checkout. Runtime V1.0
  chưa có router/backend V1.1 phải report `CHECKOUT_NATIVE_UAT_NOT_IMPLEMENTED`.
- Bổ sung hướng backend UAT tối thiểu và tách rõ backend demo với backend thương mại.

## [0.3.2] — 2026-08-23

### Added
- Checkout V1 là capability nội bộ của cùng một skill: `--capability checkout` compose client
  controller/gateway/UI trên commerce fixture, pin `zmp-sdk@2.53.0`, chạy mock merchant +
  Checkout host có badge `SIMULATOR`, và verify đủ success/pending/fail/cancel.
- Mock merchant tự resolve catalog/amount, giữ idempotency và không để MAC/mock runtime lọt vào
  source/dist. Mode simulator giữ `CHECKOUT_BACKEND_REQUIRED` và bị chặn deploy tới khi thay
  fixture bằng backend thật theo `references/checkout-backend.md`.
- Mode `--checkout-mode demo-cod` bổ sung UI xác nhận COD có nhãn `BẢN DEMO`, lưu đơn local,
  trạng thái `processing/unpaid` và trang chi tiết đơn. Mode này được deploy vào slot
  Development để lấy feedback nhưng không gọi Checkout/payment network, không vào Testing và
  luôn giữ warning `CHECKOUT_DEMO_ONLY` trước production.
- Bốn regression case Checkout nâng behavioral suite lên 41 case: client contract/safe-rerun,
  dist + warning hygiene, Development demo-cod, và full simulator flow qua transport thật của
  zmp-sdk.

### Fixed
- QR login trên chat/Remote giờ ưu tiên chụp/crop đúng QR và gửi một ảnh duy nhất; cấm stream
  raw PTY, spinner hoặc ANSI redraw. Agent ngừng poll sau khi gửi ảnh, chỉ kiểm tra lại một lần
  khi user báo đã quét. Bài học được ghi từ phiên deploy Remote ngày 2026-08-22; token custody
  và giới hạn timeout/retry giữ nguyên.

## [0.3.1] — 2026-08-22

### Fixed — 3 P0 từ audit release-readiness v0.3.0
- **Workspace mặc định = cwd, luôn luôn.** Bỏ heuristic `IN_LAB` (marker `evaluation/cases`):
  plugin Claude cài nguyên repo nên marker luôn khớp và `runs/`/`app/` bị ghi vào plugin cache
  thay vì thư mục user. Lab giờ truyền `--workspace`/`MB_WORKSPACE` tường minh. Regression:
  case `workspace-default-cwd`.
- **Safe rerun — không bao giờ ghi đè code user đã sửa.** Scaffold ghi manifest sha256
  (`app/.scaffold-manifest.json`); rerun mặc định trên app đã sửa (hoặc app không do skill tạo)
  dừng exit 2 `needs_input`/`existing_app` TRƯỚC mọi mutation. `--existing` build/verify app
  hiện có không scaffold (feature integration bắt buộc dùng), `--force-scaffold` là xác nhận
  ghi đè tường minh; rerun trên app chưa sửa vẫn idempotent. Regression: case
  `preserve-user-code`.
- **install.sh cài đúng host.** README hứa Codex nhưng default cũ cài `~/.claude/skills`.
  Interface mới `--host codex|claude|both` (default **codex** → `~/.codex/skills`), `--dest`
  giữ cho đích tuỳ ý, `--codex <dir>` deprecated. Regression: case `installer-hosts`.

### Fixed — P1
- Plugin Claude discover trùng skill (2 bản): bỏ symlink `skills/create-zmp-app`, chỉ còn
  `.claude-plugin/plugin.json` khai báo.
- `agents/openai.yaml` viết lại đúng schema hiện hành (`interface`/`policy`); mọi instruction
  nằm ở SKILL.md (Codex discover bằng SKILL.md, file yaml chỉ là UI metadata).
- CORS inspection mặc định là passive source scan, không tự gửi outbound request;
  OPTIONS probe chỉ chạy khi opt-in `MB_ENABLE_CORS_PROBE=1`. Khi probe, private/link-local,
  redirect và insecure origin vẫn được guard (finding_f62c1d32e0fa; case `cors-probe`).
- install.sh: resolve tag qua GitHub API có fallback `git ls-remote` (tránh rate-limit 60
  req/giờ); node_modules cũ chỉ được giữ khi `pnpm-lock.yaml` không đổi.
- `run.mjs --preview-timeout <ms>` (forward `preview.mjs --timeout`) cho agent/scripted use —
  preview mặc định vẫn block tới Ctrl+C cho người xem.
- Root `.env` rỗng bỏ tracking, `.gitignore` chặn `.env` mọi cấp.
- Doctor nhận biết Claude marketplace cache qua manifest/version khớp và in
  `(claude-plugin vX.Y.Z)`; install script vẫn ưu tiên `INSTALLED_VERSION`, copy tay in
  `(dev copy)` (finding_86c5901fc064; case `version-reporting`).
- SKILL.md: gỡ mâu thuẫn "silently/four points" vs "narrate progress" (4 điểm = điểm DỪNG HỎI
  user; narration là status một chiều); README thu hẹp claim "tạo app từ mô tả" đúng thực tế
  variant (clothing-store/neutral + official templates).

### Fixed — hardening sau review bản fix
- Manifest chỉ ghi **write-set** (file scaffold thực sự tạo) — file user/pipeline thêm vào
  (pnpm-lock.yaml, src generated, code tự viết) không bao giờ bị "nhận vơ" rồi gây false
  `existing_app`; guard thêm **template-identity check** (đổi template trên app sạch cũng
  dừng hỏi, không trộn hai template thành hybrid) và **pre-copy collision check** (file
  ngoài manifest mà template sắp ghi đè → dừng exit 2 TRƯỚC khi copy). Official scaffold
  fail giữa chừng (sau cpSync) vẫn ghi manifest để retry không bị coi là app lạ.
- `template.source=existing` (app ngoài, không manifest) giờ render bằng profile generic
  (như official) thay vì bộ 8 lab-marker gates — trước đó `--existing` trên app ngoài chắc
  chắn fail render vô nghĩa; sim demo cũng từ chối rõ ràng với app existing.
- CORS probe: `redirect: 'manual'` — origin public không thể 302 probe vào địa chỉ private
  (lỗ hổng bypass guard); DNS-rebinding TOCTOU còn lại được document là residual chấp nhận.
- `resolveWorkspace`: `--workspace` mà token sau là flag → exit 3 rõ ràng (trước đó
  `--workspace --force-scaffold` vừa scaffold vào thư mục `./--force-scaffold` vừa bật flag).
- install.sh: validate `--channel` (chỉ nhận staging, typo không còn âm thầm cài main);
  resolve tag lọc **stable** `vX.Y.Z` (pre-release rc/alpha không chiếm bản cài mặc định);
  flag cuối thiếu giá trị → báo lỗi usage thay vì `unbound variable`; docs `--dest` ghi đúng
  ngữ nghĩa `<dir>/create-zmp-app`.
- Pin `packageManager: pnpm@9.15.4` (root + package) cho corepack/CI khỏi trôi version.
- HUONG-DAN-TICH-HOP.md cập nhật interface install.sh mới (--host, hết --codex).
- Public official-template routing chỉ expose entry `releaseSupported=true`; v0.3.1 khoá
  `zaui-fashion` ở commit SHA đã E2E. Mẫu known nhưng experimental dừng exit 3 trước
  fetch/mutation và chỉ liệt kê support set (finding_3e3bae15af7c; case
  `official-template-support` + `official-template-golden`).
- Release suite strict: `FAIL` hoặc `BLOCKED` đều làm `npm test` đỏ; metadata validator
  chặn version/plugin/docs/template/CI drift; workflow expose context ổn định `release-gate`
  (finding_3768b1ae9aab). Ruleset `protect-main-staging` đã bind required check này sau
  workflow run đầu tiên xanh trên GitHub.
- CI fixture hygiene: commit ngoại lệ có chủ đích cho `deploy-qr-parse/fixture/deploy.log` và
  validator bắt fixture phải vừa tồn tại vừa được Git track; vòng GitHub đầu tiên đã phát hiện
  local pass giả do global `*.log` ignore (finding_7b5b15643ca1).

### Added
- Release gate: `npm test` = metadata validator + `evaluation/run-all.mjs` chạy tuần tự
  cả bộ 32 case; `.github/workflows/ci.yml` chạy trên push/PR vào `staging`/`main`. Case
  `preserve-user-code` phủ thêm: file user thêm không bị absorb, template_changed,
  write-set collision.

## [0.3.0] — 2026-08-21

### Fixed (từ 3 phiên forward-test Codex thực tế)
- Simulator: shim set `window.APP_ID` (official template trắng trang vì ZMPRouter basename) — finding_39d06fc1099a.
- Simulator: host hooks `window.zaloVersionCode`/`window.isAPISupport` + UA `android/24112050` (authorize bị -1404 vì SDK version scheme legacy `%10000`); response `auth-settings` phẳng đúng shape SDK; safety-net trả HTML placeholder cho iframe (OA widget) thay vì JSON thô — finding_a704c5494d18.
- Preflight `server_side_api_scan` chỉ quét source, loại build output `src/www` (false positive blocking trên official template vì bundle zmp-sdk chứa `graph.zalo.me`) — finding_30d7006aeaa7; kèm guard verify-sim trên app official (message rõ, không fail marker khó hiểu).

### Added
- Feature recipes (`references/feature-recipes.md`): recipe đăng nhập user Zalo chuẩn Portal (getSetting → authorize → getUserInfo → cache) + routing "Feature integration" trong SKILL.md.
- i18n matching: brief tiếng Anh / tiếng Việt có dấu lẫn không dấu (normalize NFD + đ→d hai chiều) cho variant, official-template catalog, opt-in phrases.
- Preview mặc định mở cửa sổ Chrome mobile 390x844 (`--desktop` giữ hành vi cũ).
- Facts SDK pin thêm vào `config.json sdkHostContract`: version-support scheme + host hooks, `miniProgramConfig` keys (`requiredAuthenList`/`dynamicApis`), shape `authSetting`.

## [0.2.6] — 2026-08-21

- Phase 3 — Simulator/mock host: shim biên `zmp-sdk ↔ host` (jsCall + fetch-patch openapi), permission store 3 trạng thái, bottomsheet badge SIMULATOR, mock data từ Portal docs (`sim-mock-data.json`), tab demo "Tài khoản" trong template, runner profile `simulator`, `--verify-sim`/`--preview-sim`/`--sim-decision`, doctor tự cài dependency lần chạy đầu.

## [0.2.0] — 2026-08-21

- Phase 2.6 — Quality insight + packaging: package tự chứa + single entry `run.mjs`; 8 preflight gates (size limit, security scan, CORS probe…); error-signature map + `troubleshooting.md`/`operations.md` chưng cất từ 24 FAQ cộng đồng; gate `warn` + `insights[]`.

## [0.1.0] — 2026-08-20

- Vòng 1 + Phase 2/2.5: pipeline bootstrap→portal→install→build→render→verify với browser oracle (8 markers, 3 viewport); App ID exact-binding + `--confirm-app-id`; deploy Development/Testing qua zmp-cli (QR login, sync-config, QR-decode URL); official templates opt-in (11 mẫu Zalo-MiniApp); finding→improvement→regression loop.
