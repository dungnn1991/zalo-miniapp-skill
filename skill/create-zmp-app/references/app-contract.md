# App contract — Mini App POC của lab `miniapp-bootstrap-poc`

Cụ thể hóa plan §8 cho lab này. **`config.json` là authoritative** cho marker, viewport,
variant và dependency policy — giá trị chép lại dưới đây chỉ để đọc nhanh; khi lệch nhau thì
`config.json` thắng. Template do Subagent B sở hữu tại `assets/template/`; app sinh ra nằm ở
`<workspace>/app/` và không được hand-edit.

Contract này áp dụng cho **lab template**. Scaffold từ template chính thức của platform
(Phase 2.5, opt-in) có contract riêng — marker/variant/token ở đây **không** áp dụng: xem
`official-templates.md`.

## 1. Tám marker `data-testid` (khóa)

Render oracle (`evaluation/browser/runner.mjs`) đọc selector trực tiếp từ `config.json`
(`markers`). Cả 8 marker phải hiện diện với bounding box khác 0 ở **mọi** viewport:

| Key | Selector |
|---|---|
| appRoot | `[data-testid="app-root"]` |
| appHeader | `[data-testid="app-header"]` |
| categoryFilter | `[data-testid="category-filter"]` |
| productGrid | `[data-testid="product-grid"]` |
| productCard | `[data-testid="product-card"]` |
| addToCart | `[data-testid="add-to-cart"]` |
| cartBadge | `[data-testid="cart-badge"]` |
| bottomNav | `[data-testid="bottom-nav"]` |

Ràng buộc hành vi (runner-contract): `cart-badge` luôn render **số nguyên** (kể cả `0`); click
một `add-to-cart` bất kỳ tăng badge đúng **1**. UI vẫn phải là app thật có nội dung — marker
không được là trang giả chỉ để pass gate.

## 2. Token template

Token thay thế **duy nhất**: `__APP_NAME__`, xuất hiện trong `app-config.json` và `index.html`.
`bootstrap.mjs` thay bằng `appName` (từ `--app-name` hoặc default `config.json`) lúc scaffold.
Không thêm token khác.

## 3. Cơ chế variant

- Nguồn: `assets/template/variants/<variant>/catalog.ts`; đích: `src/data/catalog.ts`
  (`template.variantTargetFile`).
- Variants khóa: `clothing-store`, `neutral`. Default trong template = `neutral`.
- `bootstrap.mjs` phân loại brief (từ khóa quần áo/thời trang/fashion/... → `clothing-store`,
  còn lại → `neutral`) rồi copy đè file catalog. Layout/component dùng chung; variant **chỉ**
  đổi copy, dữ liệu mẫu và nav labels — không fork component.
- Catalog của mỗi variant phải giữ nguyên các key `navItems` `"home"` và `"cart"` — shell bind
  hành vi tab theo đúng hai key này; variant chỉ được đổi label/data của item, không đổi key.
- Thư mục `variants/` không bao giờ được copy vào `app/`.

## 4. `.env` / `.env.example`

- `app/.env.example` chỉ có đúng `APP_ID=`. `.gitignore` của template phải ignore `.env`.
- **Lab chỉ sở hữu key `APP_ID`** trong runtime `app/.env`. Key do zmp-cli sở hữu (`ZMP_TOKEN`,
  tự ghi sau `zmp login`) **được phép tồn tại** nhưng SKILL/harness không đọc, không ghi, không
  log **giá trị** — chỉ được key-existence scan (xem `deploy-workflow.md` mục 2).
  *Thay đổi Phase 2 có chủ đích:* rule Phase 1 "runtime `.env` chỉ có `APP_ID`" được nới thành
  rule sở hữu theo key như trên.
- Nếu áp dụng vào project có sẵn, bootstrap chỉ đọc/ghi key `APP_ID` (key-level upsert, giữ
  nguyên key khác và thứ tự dòng), không bao giờ rewrite cả file.
- `APP_ID` là string exact-preserved (giữ số `0` ở đầu, không `Number()`), **không phải secret**.
  Token/cookie/credential là secret và không bao giờ xuất hiện trong app, log hoặc evidence.
- Sau khi ghi, bootstrap đọc lại và exact-compare; mismatch = hard fail `app_id_not_persisted`.
  Evidence tại `runs/<run-id>/evidence/app-id-binding.json` (build.mjs append `buildProcessAppId`).

## 5. Mobile-first / responsive

- `index.html` có `<meta name="viewport" content="width=device-width, initial-scale=1.0">`;
  CSS mobile-first.
- **Không** nhúng app vào "khung điện thoại" fixed-width giả. Viewport điện thoại là cấu hình
  của browser harness (`390x844` default; responsive gates `360x800`, `1280x800` theo
  `config.json.viewports`). Ở viewport rộng, layout phải reflow hợp lý: không horizontal
  overflow, CTA không bị cắt, product grid reflow, header/bottom-nav còn dùng được.

## 6. Surface `zmp-ui` template import

Đây là danh sách để `portal-fetch.mjs` route đúng ZaUI docs (xem `portal-routing.md` mục 3):

- Components: `App`, `Page`, `Button`, `BottomNavigation`, `Icon` — import từ `zmp-ui`.
- Stylesheet ZaUI của `zmp-ui` (import `zmp-ui/zaui.css` trong entry).
- `zmp-sdk` có mặt trong dependency graph (policy §6, `latest`) nhưng default app **không gọi**
  API host-specific nào.
- Dependency versions theo `config.json.dependencyPolicy`; không hardcode exact version
  của package Zalo trong template.

Template thêm/bớt component import → cập nhật danh sách này (và routing rule tương ứng) trong
cùng một thay đổi.

## 7. Ngoài phạm vi (vòng này)

- Native/device APIs: permission, identity, phone, location, camera, media.
- Provisioning app, production release. (*Phase 2:* login gate + deploy Development/Testing
  giờ là flow opt-in — xem `deploy-workflow.md`; token vẫn do zmp-cli sở hữu.)
- Backend, payment, OpenAPI, eKYC.
- Native bridge mock rộng — chỉ adapter tối thiểu nếu ZaUI/browser thật sự cần để render.
