# Contract vòng implement plan 34 — template intelligence (slice 1)

**Baseline:** v0.3.2 `d8c26e7`. **Mục tiêu slice này:** DoD của plan 34 —
`tạo app phòng khám hỗ trợ đặt lịch, appId=…` tự chọn `zaui-doctor` mà không cần câu "dùng mẫu",
với điều kiện doctor qua được qualification. Phần semantic envelope do agent sinh để vòng sau;
slice này chạy ranker deterministic trên metadata registry (review 35 F5 + phản biện chéo:
ship vertical slice ngắn).

## LEAD đã khóa (không sửa)

| File | Nội dung |
|---|---|
| `catalog/taxonomy.json` | Enum đóng: 10 domain, 20 job, 10 capability. Thêm id mới phải kèm case corpus |
| `catalog/templates.json` | Registry 12 profile, revision/head/license/state thật (fetch 2026-08-22) |
| `schemas/template-profile.schema.json` | Shape một profile |
| `schemas/intent-envelope.schema.json` | Shape envelope (vòng sau agent sinh; slice này fallback deterministic) |
| `schemas/template-selection.schema.json` | Shape kết quả ranker, ghi vào input.json + result.json |
| `schemas/input.schema.json` | Đã bump: `schemaVersion` 1.0\|1.1, thêm `templateSelection`, `intentEnvelope` |
| `schemas/result.schema.json` | Đã bump: `needsInput.reason` += `template_choice`, `needsInput.templateOptions`, `templateSelection` |

Trạng thái registry hiện tại: 1 `release-supported` (fashion), 8 `candidate` (portal-listed),
3 `discovered` (không có trên Portal: restaurant, shop, mmenu).

## Quy tắc chung của slice

1. **Runtime không fetch catalog mutable.** Scaffold chỉ dùng `source.revision` đã pin trong
   registry. `headObserved` chỉ để phát hiện drift.
2. **Hard-filter chạy trước score.** Auto-scaffold chỉ với `state=release-supported`, có
   `revision`, `testedRevision===revision`, và `licenseDecision !== 'review-required'`.
3. **License là gate của promotion, không hồi tố.** `zaui-fashion` đang ship được grandfather
   (ghi rõ trong registry note), nhưng **không template mới nào được promote lên
   `release-supported` khi `licenseDecision='review-required'`** — chờ D34-8 của owner.
4. **Package manager:** pipeline dùng `pnpm` (isolated). Template dựa vào hoisting của npm sẽ
   fail — đó là lỗi thật của template, xử lý bằng adapter khai dependency thiếu, KHÔNG bằng
   `shamefully-hoist` và KHÔNG bằng đổi sang npm cho riêng template đó.
5. **Adapter** chỉ áp cho đúng `template id + exact SHA + precondition`; mỗi adapter phải có
   diff evidence và finding upstream tương ứng.
6. Không mutation nào trước khi selection được finalize.

## Phân vùng

### Subagent A — resolver, ranker, tích hợp bootstrap, docs
- `scripts/recommend-template.mjs` (mới): đọc registry + taxonomy, nhận brief thô, trả
  `templateSelection` đúng schema. Deterministic: normalize hai chiều (đã có `normalizeVi`
  trong bootstrap — tách sang lib dùng chung hoặc copy có ghi nguồn), match alias/domain/jobs,
  hard-filter trước score, tính `score` + `margin`, xuất `reasons`/`evidence`/`alternatives`.
- `scripts/bootstrap.mjs`: `--template auto` là **mặc định**; bỏ `optInPhrases` khỏi vai trò
  gate (giữ như tín hiệu ưu tiên); `--template lab` ép lab; `--template official:<id>` giữ
  nguyên semantics (obey nếu supported, dừng trước mutation nếu không). Ghi `templateSelection`
  vào `input.json`. **Đổi `needs_template_choice` từ exit 3 sang exit 2** với
  `needsInput.reason='template_choice'` + `templateOptions` 2-3 lựa chọn kèm `why`.
- `SKILL.md`, `agents/openai.yaml`, `references/template-routing.md` (mới),
  `references/official-templates.md` (đổi thành routing/qualification contract, số liệu sinh từ
  registry chứ không hardcode).
- KHÔNG đụng: catalog/, schemas/, qualify/sync script, evaluation/, verify.mjs, run.mjs.

### Subagent B — catalog sync + qualification factory
- `scripts/sync-template-catalog.mjs` (mới): đọc Portal JSON
  `https://miniapp.zaloplatforms.com/static/static/templates/index.json` (chú ý: URL một
  `static` trả HTML SPA — phải validate `content-type: application/json` + shape + count, sai
  thì fail loud) và GitHub org, so với registry, **chỉ in diff/report**, không tự sửa registry,
  không tự nâng state.
- `scripts/qualify-template.mjs` (mới): chạy factory trên clean temp workspace theo plan §4.4:
  provenance → dependency (pnpm, clean cache) → build → rebrand/App ID → runtime (browser
  oracle profile `official-template`) → external dependency → safe rerun. Ghi
  `qualification-result.json` (SHA, toolchain, từng gate, adapter, finding). Promotion sang
  `release-supported` phải bị **chặn** nếu `licenseDecision='review-required'`.
- `catalog/adapters/<id>.json`: adapter pin theo SHA + precondition + diff evidence.
- Chạy qualification thật cho `zaui-doctor` (SHA `d6e5997754671a47ed9d618cee7975cbc7a057e9`).
  Lỗi đã biết: (a) `resolve.alias {"@":"/src"}` cùng `root:"./src"` → Vite thử
  `<project>/src/src/...` rồi mới tới `/src/...` trên filesystem, cả hai đều miss; (b)
  `src/components/error-boundary.tsx:7` import `useRouteError` từ `react-router` trong khi
  `package.json` chỉ khai `react-router-dom@^7.6.1` (v7 để `react-router` là transitive) → pnpm
  isolated fail, npm hoisting pass. Ghi finding upstream cho cả hai.
- **Lưu ý môi trường:** shell có `HTTPS_PROXY=http://10.164.68.254:81` làm pnpm lỗi
  `self-signed certificate`. Chạy install bằng `env -u HTTPS_PROXY -u https_proxy pnpm …`.
- KHÔNG đụng: bootstrap/SKILL/docs của A, evaluation/ của C, schemas.

### Subagent C — gold corpus, evaluation, migration exit-code
- `evaluation/routing-corpus/` (mới): fixture theo plan §6.1. Slice này làm **tập blocking ~40
  case** cho domain đã/sắp support + nhóm safety; tập discovery còn lại đánh dấu
  non-blocking để không chặn release (phản biện chéo F6).
  Bắt buộc có các nhóm: domain rõ, F&B overlap, commerce overlap, có dấu/không dấu/English,
  paraphrase, mixed intent, entity-vs-domain (`bán đồng phục bác sĩ` → commerce, KHÔNG healthcare),
  ambiguous (`app nhà hàng` → hỏi một câu), unsupported (`app thời tiết` → lab), explicit override,
  constraint (mmenu thiếu API URL), safety (prompt injection đòi bỏ support gate).
- `evaluation/cases/run-corpus.mjs`: chạy corpus, tính top-1 accuracy trên tập blocking, in
  bảng fail. Exact-match chỉ cho id/decision; KHÔNG exact-match câu giải thích.
- Cập nhật consumer của exit 3 cho template choice: `evaluation/cases/*` liên quan,
  `run-case.mjs`, `scripts/run.mjs`, `verify.mjs` nếu cần. Đổi **atomic**, không giữ hai
  hành vi song song, không in deprecation ra stdout (stdout là kênh JSON).
- Regression: toàn bộ 32 case cũ phải xanh; `official-template-golden` giữ nguyên hành vi.
- KHÔNG đụng: catalog/, schemas/, bootstrap/SKILL của A, qualify/sync của B.

## Definition of done của slice

1. `tạo app phòng khám hỗ trợ đặt lịch, appId=…` (và biến thể không dấu/English) route tới
   `zaui-doctor` **nếu** doctor đạt qualification + license được duyệt; nếu chưa, report nói rõ
   lý do và không âm thầm rơi về template sai domain.
2. `tạo app thời tiết` → lab, không ép vào template nào.
3. `app nhà hàng` → một câu hỏi phân loại hữu ích, exit 2.
4. `bán đồng phục bác sĩ` → commerce, không healthcare.
5. Explicit `official:<id>` với template chưa support → dừng trước network/mutation.
6. 32 regression case cũ xanh; corpus blocking đạt top-1 ≥ 90%.
