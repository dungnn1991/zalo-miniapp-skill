# Template routing — chọn template nào, vì sao, và khi nào dừng lại hỏi

Contract đầy đủ của tầng chọn template (plan 34). `SKILL.md` chỉ giữ phần tóm tắt; chi tiết và
lý do thiết kế nằm ở đây.

## 1. Nguồn sự thật

`catalog/templates.json` là registry local, và là thứ **duy nhất** runtime được dùng để scaffold.
Mỗi profile khai `source` (repo, branch, `revision` đã pin, `headObserved`, license),
`intent` (domains/jobs/aliases/negativeSignals), `capabilities`, `constraints` và `qualification`.

Runtime **không bao giờ** fetch catalog động. Portal và GitHub chỉ được đọc bởi
`scripts/sync-template-catalog.mjs`, và script đó chỉ **báo drift** — nó không sửa registry,
không tự nâng trạng thái. Lý do: một bản release phải tái hiện được sau nhiều tháng, kể cả khi
upstream đã đổi.

Từ vựng dùng để so khớp nằm ở `catalog/taxonomy.json` (enum đóng). Không tự đặt domain/job/
capability mới; thêm id phải kèm case trong routing corpus.

## 2. Bậc thang trạng thái

| State | Nghĩa |
|---|---|
| `discovered` | Thấy ở nguồn candidate, chưa đủ metadata |
| `candidate` | Metadata đủ, chưa qua đủ gate |
| `build-qualified` | Clean install + build pass tại đúng SHA |
| `render-qualified` | Thêm: mount thật, có nội dung, không console error, không tràn ngang ở 3 viewport, App ID bind đúng, rerun an toàn |
| `interaction-qualified` | Thêm: smoke luồng chính của template |
| `release-supported` | Đủ mọi gate blocking và được phép auto-route |
| `quarantined` | Có lỗi/ràng buộc đã biết, ghi rõ lý do và cách gỡ |
| `deprecated` | Upstream archive hoặc owner rút support |

**Bậc tối thiểu để auto-scaffold là `render-qualified`** (`AUTO_SCAFFOLD_STATES` trong
`scripts/recommend-template.mjs`). Lý do: template official chạy qua oracle profile
`official-template`, vốn bỏ marker/interaction gate của lab, nên factory không bao giờ cấp được
`interaction-qualified` cho chúng — lấy `release-supported` làm điều kiện cứng thì cả 9 template
Portal vĩnh viễn không dùng được.

`render-qualified` bảo đảm app dựng lên và hiển thị đúng. Nó **không** bảo đảm các luồng nghiệp
vụ chạy đúng; điều đó thuộc bậc `interaction-qualified`.

## 3. Thứ tự quyết định

```
--template lab            → lab shell, không xét gì thêm
--template official:<id>  → obey nếu qua hard-filter; nếu không thì DỪNG trước mọi fetch
--template auto (mặc định)→ hard-filter → score → quyết định
```

### 3.1. Hard-filter (chạy TRƯỚC khi điểm số được dùng)

Một template bị loại nếu: state dưới `render-qualified`; không có `revision` đã pin;
`testedRevision` lệch `revision` (evidence hết hiệu lực); `licenseDecision` chưa được duyệt;
thiếu `requiredInputs` cho preview đầu tiên; hoặc cần backend riêng mới render được.

Template bị loại **vẫn xuất hiện** trong `alternatives[]` kèm `rejectedBecause`, để báo cáo nói
được vì sao không dùng nó.

### 3.2. Chấm điểm

Theo thứ tự trọng số: domain chính → domain phụ → jobs → capabilities → alias, trừ điểm nặng cho
negative signal (đủ sức lật một lựa chọn), và trừ cho ràng buộc chưa thoả.

Hai ngưỡng `AUTO_SELECT_MIN_SCORE` / `AUTO_SELECT_MIN_MARGIN` là hằng số có tên, export ra để
hiệu chỉnh bằng corpus chứ không sửa rải rác trong code.

**Điều kiện bắt buộc: phải có domain evidence.** Brief chỉ khớp job hoặc capability
(`primaryDomain == null`) không bao giờ được auto-scaffold, dù điểm vượt ngưỡng — cùng một job
xuất hiện ở nhiều ngành (`appointment.booking` có ở cả phòng khám lẫn dịch vụ công), nên chọn
theo job là đoán ngành. Trường hợp đó đi lab, ứng viên điểm cao vẫn nằm trong `alternatives[]`.

Ứng viên không khớp domain nào cũng không được đưa vào câu hỏi lựa chọn, vì cùng lý do.

### 3.3. Bảng quyết định

| Tình huống | Kết quả |
|---|---|
| Top-1 qua hard-filter, đủ score và margin, có domain evidence | `auto` — scaffold ngay ở revision đã pin |
| Hai hướng sản phẩm khác nhau, điểm gần nhau, **có domain evidence** và ít nhất một cái scaffold được | `choice` — exit `2`, hỏi đúng một câu với 2–3 lựa chọn |
| Brief chỉ khớp job/capability (không có domain evidence) | `lab` — kể cả khi có hai hướng sản phẩm: hỏi "phòng khám hay thời trang?" khi brief không nói ngành là bắt user chọn giữa hai phỏng đoán |
| Ứng viên tốt nhất chưa qualify, user **không** yêu cầu mẫu có sẵn | `lab` + báo rõ đã bỏ qua ứng viên nào và vì sao |
| Ứng viên tốt nhất chưa qualify, user **có** nói "dùng mẫu có sẵn" | `choice` — không im lặng rơi về lab khi user đã nêu ý định |
| Không khớp domain nào | `lab` |
| `official:<id>` không tồn tại hoặc chưa qualify | Dừng trước mọi fetch/mutation (exit `2`), nêu lý do và liệt kê thứ dùng được |
| `--template` mang giá trị ngoài `auto` / `lab` / `official:<id>` | exit `3` — lỗi cấu hình, không phải câu hỏi cho user; im lặng coi như `auto` sẽ khiến user tưởng đã ghim template |

`optInPhrases` trong `config.json` **không còn là cổng chặn** (D34-1). Nó chỉ còn là tín hiệu ý
định, dùng đúng ở dòng thứ tư của bảng trên.

## 4. Không có mutation trước khi chốt

Mọi nhánh dừng đều xảy ra **trước** khi tải tarball hoặc ghi vào `app/`. Kiểm được bằng case
`official-template-support`: sau một lần dừng, workspace không có `app/` và không có thư mục tạm
`.official-tpl-*`.

## 5. Ghi vết

`input.json` và `result.json` mang `templateSelection` (schema
`schemas/template-selection.schema.json`): `mode`, `selectedId`, `revision`, `confidence`,
`score`, `margin`, `reasons[]`, `evidence[]`, `alternatives[]`, `registryVersion`. Run cũ không
có field này được hiểu là legacy lab/explicit theo `input.template`.

## 6. Thêm hoặc nâng cấp một template

1. `node scripts/sync-template-catalog.mjs` — xem drift, không sửa gì.
2. Bổ sung profile vào `catalog/templates.json` (intent/aliases/constraints).
3. `node scripts/qualify-template.mjs --id <id>` — chạy factory, đọc evidence.
4. Lỗi upstream: viết adapter trong `catalog/adapters/<id>.json`, pin theo `templateId + SHA`,
   có precondition để không vá chồng, có ngày hết hạn, và ghi finding cho upstream.
5. `--promote` khi mọi gate blocking xanh và license đã duyệt. Không sửa tay state trong registry.
6. Thêm case vào `evaluation/routing-corpus/cases/`; dùng `decisionWhenSupported` /
   `decisionWhenUnsupported` để case đúng cả trước lẫn sau khi promote.
