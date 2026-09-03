# Portal routing — live Markdown grounding cho `create-zmp-app`

Reference cho `scripts/portal-fetch.mjs`. Đọc khi cần hiểu vì sao một doc được chọn hoặc vì sao
run fail ở stage `portal`. Cấu hình khóa trong `config.json` (`portal` block) — file đó là
source of truth, reference này chỉ giải thích.

## 1. Nguồn gốc base URL

- Base URL: `https://docs.zaloplatforms.com` — index `/MA/llms.txt`, per-doc `/docs/MA/<slug>.md`.
- Provenance (DX workspace, không ship cùng skill): file 06
  (`06-independent-verification-brief.md`) và file 10
  (`10-independent-principal-review-2026-07-29.md`).
- Verified live 2026-08-20: HTTP 200, ETag `"6a857e93-9f51"` (ghi trong `config.json`
  `portal.note`).

Env var **`MB_PORTAL_BASE_URL`** override base URL — **chỉ dành cho test** (negative control
`portal_unavailable` với host không tồn tại). Không dùng cho run thật; không bao giờ sửa
`config.json` để test.

## 2. Flow

```text
GET <baseUrl>/MA/llms.txt                  # index, blocking duy nhất
→ parse Markdown links [title](absolute .md URL) có prefix <baseUrl>/docs/MA/
→ chọn slug theo topic group (mục 3), tối đa 8 doc
→ GET từng doc URL
→ lưu body vào runs/<run-id>/portal/  (evidence trace, KHÔNG phải corpus)
→ ghi runs/<run-id>/portal-sources.json
```

## 3. Quy tắc chọn slug theo topic

Default topics (khi không có `--topics`): `getting-started`, `app-config`, `zaui`, `devtools` —
đúng seed groups của plan §7. Slug thật do index quyết định lúc chạy; bảng dưới là rule matching,
kèm slug quan sát được ngày 2026-08-20:

| Topic | Rule | Slug quan sát 2026-08-20 |
|---|---|---|
| `getting-started` | slug path đúng bằng `intro/getting-started.md` | `intro/getting-started.md` |
| `app-config` | slug path kết thúc bằng `/app-config.md` | `devtools/app-config.md` |
| `zaui` | `zaui/overview/installation.md` + component docs `zaui/<group>/<Component>.md` cho đúng các component template import (`App`, `Page`, `Button`, `BottomNavigation`, `Icon` — xem `app-contract.md`) | `zaui/overview/installation.md`, `zaui/layout/App.md`, `zaui/layout/Page.md`, `zaui/form/Button.md`, `zaui/layout/BottomNavigation.md`, `zaui/display/Icon.md` |
| `devtools` | `devtools/cli/intro.md` hoặc `devtools/cli/start.md` — chỉ local build/render, **không bao giờ** chọn doc login/deploy | `devtools/cli/intro.md` |
| `permissions` | slug path đúng bằng `intro/request-permission.md` (thêm 2026-08-26, plan51 — không thuộc default topics) | `intro/request-permission.md` (quan sát 2026-08-26) |
| `best-practices` | head `intro/best-practices/authen-user.md`, rồi tối đa 4 trang `intro/best-practices/*` khác (thêm 2026-08-26, plan51 — không thuộc default topics) | `authen-user`, `widget-follow-oa`, `call-restful-api`, `interact-with-zalo-app`, `cache-data` (quan sát 2026-08-26) |

Cap tổng: **≤ 8 doc**, chọn head-first: mỗi topic được đảm bảo doc **đầu tiên** của nó trước
(theo thứ tự topic), phần còn lại (chủ yếu ZaUI components theo thứ tự import) nối tiếp sau,
dedupe theo URL rồi cắt từ đuôi. Với default topics, kết quả là 8 doc: 4 head
(`getting-started`, `app-config`, ZaUI installation, `devtools/cli/intro`) + 4 component đầu
(`App`, `Page`, `Button`, `BottomNavigation`); `zaui/display/Icon.md` là doc bị cắt.

`--topics <csv>` thay thế default. Topic ngoài các nhóm có rule ở trên match generic theo
substring của slug/title (tối đa 2 doc mỗi topic) — dùng cho thử nghiệm, không phải contract.
Nội dung ổn định của `permissions`/`best-practices` đã được chưng cất sẵn vào
`permissions.md` + `feature-recipes.md` (Recipe 1/3/4/5); hai topic này dùng khi cần bản
sống mới nhất từ Portal.

Không fetch native API docs (`api/...`) — app POC chưa dùng native API (plan §7, §8).

## 4. Chính sách no-bundle / no-fallback

- SKILL **không bundle** corpus/snapshot Portal nào. Mọi nội dung docs đều fetch live per-run.
- Index không fetch được (network error hoặc non-200) → exit `1`, finding `portal_unavailable`
  (stage `portal`, category `environment`, severity `blocking`), **không ghi artifact nào khác**,
  không fallback âm thầm sang snapshot.
- Một doc lẻ fail → mark `"failed"` trong `portal-sources.json`, ghi finding severity `major`
  (`portal-content` nếu HTTP error — link hỏng trong index; `environment` nếu network error),
  nhưng vẫn fetch tiếp các doc còn lại. Exit `0` khi index + ít nhất 1 doc thành công.
- `portal-sources.json` chỉ phục vụ trace/debug từng run; không phải audit record, không khóa
  Portal version.

## 5. Shape của `portal-sources.json`

```json
{
  "schemaVersion": "1.0",
  "baseUrl": "https://docs.zaloplatforms.com",
  "sources": [
    {
      "url": "https://docs.zaloplatforms.com/docs/MA/intro/getting-started.md",
      "fetchedAt": "2026-08-20T10:30:00.000Z",
      "etag": "\"...\"",
      "sha256": "<hex của body>",
      "status": "fetched"
    }
  ]
}
```

- `etag`: response header, `null` nếu server không trả.
- `sha256`: hash của body; `null` khi `status: "failed"`.
- Body lưu tại `runs/<run-id>/portal/<slug-path với "/" thay bằng "__">.md`
  (ví dụ `zaui__layout__App.md`) — flatten để tránh trùng basename giữa các nhóm; đã qua
  redact allowlist như mọi evidence khác.
