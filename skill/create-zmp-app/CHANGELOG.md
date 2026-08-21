# Changelog — create-zmp-app

Mọi thay đổi đáng kể của skill. Version = `package.json` + git tag `vX.Y.Z` trên nhánh `main`.
Mỗi mục gắn finding id (chi tiết expected/actual/verified trong `feedback/findings.jsonl` của repo).

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
