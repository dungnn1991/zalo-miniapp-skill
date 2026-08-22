# Official templates — scaffold từ mẫu chính thức của platform (Phase 2.5, opt-in)

Reference cho đường scaffold official-template của `bootstrap.mjs`. **`config.json` mục
`catalog/templates.json` là authoritative** cho catalog (số lượng và trạng thái đọc từ registry, không hardcode ở đây), tập
`releaseSupported`, keywords, immutable revision, tarball URL pattern và match order — file
này chỉ giải thích cơ chế; khi lệch nhau thì `config.json` thắng. Nguồn catalog:
`github.com/Zalo-MiniApp` (observed 2026-08-22; gallery
`miniapp.zaloplatforms.com/zaui-templates` là SPA nên org GitHub là ground truth).

## 1. Khi nào kích hoạt

- **Không bao giờ bắt buộc.** Default luôn là lab template (demo shell
  `clothing-store` hoặc `neutral`, không phải generator UI domain tuỳ ý); user có thể yêu
  cầu agent tích hợp tiếp tính năng trên shell.
- Kích hoạt khi: brief chứa một opt-in phrase (`optInPhrases` — "mẫu có sẵn", "template chính
  thức", "dùng mẫu", ...) **hoặc** explicit `--template official:<id>`.
- Routing khi opt-in bằng phrase: duyệt `catalog` **theo thứ tự khai báo**, template đầu tiên
  có keyword khớp brief thắng. Chỉ entry `releaseSupported=true` được scaffold; cờ `verified`
  chỉ ghi bằng chứng test và không tự mở public support. Explicit flag không bypass rule này.
- Opt-in không match template supported, hoặc match một entry experimental → exit `3` trước
  fetch/app mutation, dòng stdout JSON cuối
  `{"runId":..., "status":"needs_template_choice", "question":..., "catalog":[<ids>]}` —
  agent dừng, hỏi user chọn id supported hoặc bỏ opt-in để dùng lab template. **Không đoán,
  không âm thầm fallback.** (Dùng exit 3 + JSON này thay vì thêm
  reason mới vào `needsInput` enum của result.schema.)
- `--template official:<id-không-tồn-tại>` → exit `3`, stderr liệt kê toàn bộ ids hợp lệ.

## 2. Cơ chế scaffold

```text
fetch tarball codeload (tarballUrlPattern, commit `revision` immutable theo catalog)
→ giải nén bằng system `tar -xzf` vào temp dir trong workspace (tự dọn, kể cả khi fail)
→ strip top-level dir → copy vào <workspace>/app/ (không bao giờ copy file .env nào)
→ rebrand: package.json + zmp-cli.json field `name` = slug(appName);
  app-config.json chỉ đổi field title/app.title ĐANG CÓ (giữ nguyên structure gốc)
→ .env APP_ID binding + read-back + evidence/app-id-binding.json — Y HỆT đường lab template
```

- **KHÔNG** dùng `zmp init` (interactive, treo non-tty) và **không** git clone — chỉ tarball.
- `app/` đã tồn tại → safe-rerun manifest áp dụng như lab template; edited/foreign/different
  revision dừng `existing_app`, chỉ `--force-scaffold` sau xác nhận mới ghi đè. `.env` luôn
  key-level upsert.
- Fetch tarball fail (network/non-200/tar lỗi) → finding `official_template_unavailable`
  (stage `scaffold`, category `environment`, severity `blocking`), `result.json` fail, exit `1`
  — cùng pattern `portal_unavailable`, không fallback âm thầm.
- `input.json` ghi `template: {source: "official", id: "<id>", revision: "<sha>"}` (đường lab ghi
  `{source: "lab", id: "lab-template"}`; run cũ không có field này = lab — backward compat).
  `variant` vẫn được ghi nhưng **bị bỏ qua** với official (cơ chế của lab template).

## 3. Những gì KHÔNG áp dụng với official template

| Cơ chế lab template | Với official |
|---|---|
| 8 marker `data-testid` (app-contract.md mục 1) | Không có — render chạy oracle profile `official-template` (`config.json` `oracleProfiles`): giữ react_mount (`#app, #root, [data-testid="app-root"]`), overflow, console, screenshot; marker/interaction/CTA gates ghi `skipped`, không fail |
| Token `__APP_NAME__` | Không dùng — rebrand bằng field `name`/`title` có sẵn (mục 2) |
| Variants `clothing-store`/`neutral` | Không dùng — nội dung do template chính thức quyết định |
| Dependency policy pin của lab (Vite 5, dist) | Template chính thức tự mang manifest của nó |

## 4. Khác biệt build/render/deploy (phía harness — Subagent C xử lý)

- Build: template chính thức có thể có script `build:css` (chạy trước nếu có); outDir thường
  là `www` thay vì `dist` (zmp-vite-plugin default; vite root có thể là `./src`). `build.mjs`
  tự detect outDir sau build (dir chứa `index.html` mới nhất trong `{dist, www, src/www,
  src/dist}`) và ghi vào events cho render/deploy dùng.
- Render: profile suy từ `input.json` `template.source` (`official` → `official-template`,
  còn lại → `full`).
- Deploy: dùng chung contract Phase 2 nhưng vòng này **không deploy** build từ official
  template (dev slot đang giữ bản POC user đã UAT; deploy template app là quyết định riêng
  của user, ngoài vòng này).
