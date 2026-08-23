# Official templates — scaffold từ mẫu chính thức của platform

File này giải thích **cơ chế** scaffold official-template của `bootstrap.mjs`: fetch, rebrand,
những gì khác lab template, và khác biệt build/render/deploy. Nguồn catalog:
`github.com/Zalo-MiniApp` (gallery `miniapp.zaloplatforms.com/zaui-templates` là SPA nên org
GitHub là ground truth).

## 1. Chọn template — xem `template-routing.md`

**Toàn bộ phần quyết định *chọn template nào* nằm ở
[`template-routing.md`](./template-routing.md)**, không nằm ở đây. Tóm tắt để khỏi phải mở file
kia khi chỉ cần cơ chế:

- Registry `catalog/templates.json` là **authoritative** cho danh sách template, bậc
  qualification, revision đã pin, license và required inputs. Khối `officialTemplates` trong
  `config.json` chỉ còn `tarballUrlPattern` + `optInPhrases`; các field routing cũ ở đó đã
  deprecated (xem `deprecatedSince`).
- `--template auto` là **mặc định**: mọi brief đều được ranker chấm điểm, user không cần nói
  "dùng mẫu có sẵn". `lab` ép dùng shell đi kèm, `official:<id>` chỉ đích danh. Giá trị khác
  → exit `3`.
- Tự scaffold cần **domain evidence** và bậc ≥ `render-qualified`. Mơ hồ mà có ít nhất một
  lựa chọn dựng được → exit `2` + `needsInput.reason="template_choice"`. Id không tồn tại
  hoặc chưa qualify → exit `2` blocked, nêu rõ cái nào dùng được. Không đoán, không âm thầm
  fallback, không fetch/mutate trước khi chốt.

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
