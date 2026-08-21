# Finding & improvement workflow

Nguyên tắc gốc (plan §11): **không silent fix** — mọi lỗi không kỳ vọng hoặc workaround phát sinh
phải có finding trong `feedback/findings.jsonl` **trước khi run kết thúc**. Agent không được sửa
âm thầm rồi chỉ trả kết quả xanh. `verify.mjs` cưỡng chế điều này: mỗi gate fail đều được ghi
finding qua `record-finding.mjs`.

## Lifecycle

```text
open → triaged → fixed → verified
```

| Bước | Điều kiện | Lệnh |
|---|---|---|
| **open** | Run phát hiện lỗi (script stage hoặc verify gọi `recordFinding`) | tự động, hoặc thủ công: `node record-finding.mjs --workspace <ws> --run-id <id> --stage <s> --category <c> --severity <sev> --expected "<e>" --actual "<a>" [--evidence <csv>]` |
| **triaged** | Đã xác định owner — bắt buộc `--owner` | `node record-finding.mjs --update <findingId> --status triaged --owner skill\|portal\|template\|dependency\|harness` |
| **fixed** | Đã sửa source nhỏ nhất phù hợp + ghi improvement | `node record-finding.mjs --update <findingId> --status fixed` |
| **verified** | Chạy lại **cùng input** và pass — bắt buộc `--verified-by` | `node record-finding.mjs --update <findingId> --status verified --verified-by <runId>` |

`--status verified` không có `--verified-by`, hoặc `--status triaged` không có `--owner` → exit 3,
không ghi gì.

## Fingerprint dedupe

`fingerprint = sha256(stage | category | normalize(expected) | normalize(actual))` — normalize là
lowercase + collapse whitespace (lib `run-context.mjs`, LOCKED). Số (exit code, px) được giữ lại.

- Cùng fingerprint xuất hiện lại → **merge**: `occurrences+1`, `lastSeenAt=now`; giữ nguyên
  `findingId`, `firstSeenAt`, `runId` (run đầu tiên phát hiện) và `status`.
- `findingId = finding_<12 hex đầu của fingerprint>` — stable, dùng để triage/link improvement.
- Stage script và `verify.mjs` dùng **cùng một bộ text** expected/actual (export từ
  `install.mjs`/`build.mjs`) để cùng một lỗi không sinh hai finding.
- File được rewrite atomic (temp + rename) — không bao giờ có jsonl viết dở.

## Category → owner routing

| category | owner mặc định | Ghi chú |
|---|---|---|
| `input` | skill | Parse/App ID resolution trong bootstrap |
| `skill` | skill | Workflow, binding, portal routing logic |
| `portal-content` | portal | **Chỉ route, không fix trong lab** — Portal Markdown là generated của Portal owner |
| `template` | template | Marker, mount, layout, variant data |
| `app` | template | `app/` là generated — sửa nguồn ở template (hoặc skill nếu lỗi do scaffold) |
| `dependency` | dependency | Version policy, upstream package |
| `environment` | harness | Node/pnpm/OS/Chrome của máy chạy |
| `harness` | harness | Script C, runner, evidence pipeline |

## Improvement linkage

```text
findingId → decision + changedFiles → regressionCaseId → verifiedByRunId
```

```bash
node record-finding.mjs --improve --finding <findingId> \
  --decision "sửa gì, vì sao — smallest source fix" \
  --files skill/create-zmp-app/assets/template/src/App.tsx \
  [--regression-case <caseId>] [--verified-by <runId>]
```

- `changedFiles` phải là **source** (skill/template/harness) — không bao giờ là `app/` hay `runs/`
  (generated, sẽ bị scaffold/run sau ghi đè).
- `regressionCaseId` trỏ tới case dưới `evaluation/cases/` chặn tái diễn.
- Finding chỉ được mark `verified` khi improvement có `verifiedByRunId` — một run mới chạy lại cùng
  input và pass. Hai run khác nhau chứng minh `open → fixed → verified` (plan P3).

## Phase 2 (login/deploy)

- Stage mới cho finding: `login`, `deploy` (result.schema.json 1.1 đã có; finding.schema.json
  đang chờ lead bump enum tương ứng).
- Routing mặc định: finding stage `deploy` category `dependency` → owner **dependency (zmp-cli)**
  — ví dụ `deploy_output_unparseable` (nhu cầu machine-readable output đã nêu ở W1 direction).
  Gate `login_not_scripted` fail → category `skill` (guardrail agent vi phạm). Gate
  `no_token_in_evidence` fail → category `harness` (redaction pipeline thủng) — severity blocking.
- Token custody trong finding text: **không bao giờ** đưa giá trị token/JWT vào
  `expected`/`actual`/`detail` — chỉ nêu tên file + loại pattern. `redactText` là lưới cuối,
  không phải giấy phép.

## Ghi chú vận hành

- `feedback/*.jsonl` là append/merge — không xóa finding cũ; lịch sử occurrences là dữ liệu.
- `expected`/`actual`/`evidence` đều đi qua `redactText` (lib LOCKED) — không secret trong feedback.
- `evidence` là đường dẫn tương đối dưới `runs/<run-id>/` (vd `evidence/build.log`).
