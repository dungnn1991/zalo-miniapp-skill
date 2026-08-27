# bench/ — quy trình đo token của skill theo release

Tooling dev ở root repo, **không thuộc bộ skill release**: agent không bao giờ nạp thư mục
này vào context, và nó không nằm trong `skill/create-zmp-app/`. Không chạy trong CI (tầng
động tốn tiền API thật); chạy tay mỗi release.

Câu hỏi nó trả lời: **bản release mới làm skill tốn nhiều/ít token hơn bản trước bao nhiêu?**
— tách làm hai tầng vì "token của skill" là hai thứ khác nhau.

## Tầng 1 — tĩnh (miễn phí, deterministic, chạy mỗi release)

Đo trọng-lượng-context của chính các file skill ở 3 mức:

- **tax** — `description` frontmatter: mọi session có cài plugin đều trả, kể cả không dùng skill;
- **trigger** — toàn bộ `SKILL.md`: trả khi skill được invoke;
- **ondemand** — `references/*`, `schemas/*`, `config.json`: trả khi agent mở từng file.

```bash
node bench/token-budget.mjs                    # bảng cho working tree
node bench/token-budget.mjs --compare v0.4.1   # delta so với một tag/commit
node bench/token-budget.mjs --api              # số chính xác qua count_tokens (cần ANTHROPIC_API_KEY)
```

Mặc định là ước lượng offline (length/3.4): số tuyệt đối xấp xỉ, nhưng cùng estimator ở cả
hai ref nên **delta giữa hai release là tin được**.

### Sổ theo dõi tự động — `bench/HISTORY.md`

Lịch sử tăng/giảm qua từng version nằm ở [`HISTORY.md`](./HISTORY.md) (tracked trong git —
nhìn một file là thấy skill phình ra hay được tối ưu). Ghi sổ bằng:

```bash
node bench/token-budget.mjs --record --note "lý do chính của đợt thay đổi"
```

(idempotent — chạy lại thay row của version hiện tại, delta tự tính so với row trước).
**Tự động hoá:** release-gate có check `bench token-budget history records current version` —
đo lại từ working tree và so exact với row của version trong sổ; bump version mà quên
`--record`, hoặc sửa skill sau khi đã ghi sổ, là CI đỏ với message chỉ đúng lệnh cần chạy.

## Tầng 2 — động (agent thật, tốn tiền, chạy có chủ đích)

Chạy `claude -p` với corpus prompt cố định (`bench/scenarios.json`), mỗi run một workspace
`mktemp` riêng, kết quả thô lưu `bench/results/<label>/` (gitignored):

```bash
bench/bench-agent.sh --label v0.5.0                # mặc định: scenario rẻ (S4, S5) × 3 run
bench/bench-agent.sh --label v0.5.0 --heavy        # gồm cả S1 create full (tốn nhất)
node bench/summarize.mjs v0.5.0 v0.4.1             # bảng so hai bản đã đo
```

**Trước khi đo một release phải cài đúng bản plugin đó** — script đo plugin đang active trên
máy, không phải working tree; `meta.json` ghi lại model/claude-version/thời điểm để đối chiếu.

### Đọc số cho đúng (đúc kết từ thiết kế quy trình, 2026-08-26)

- **`volume` = input + cache_read + cache_creation** — tổng context model xử lý, gần như bất
  biến với trạng thái cache → **đây là số để so giữa release**.
- **`cost ($)` phụ thuộc cache**: run đầu *cold* (cache_creation cao), các run sau trong TTL
  là *warm* (cache_read, ~0.1×). `summarize` gắn nhãn regime từng run — muốn cost cold thì
  các lần chạy cách nhau quá TTL; muốn cost warm steady-state thì bỏ run #1.
- **Độc lập giữa các run**: cách ly workspace là bắt buộc — thiếu nó, run #2+ đập guard
  `existing_app` và trở thành kịch bản khác (ngắn hơn hẳn), không phải nhiễu đo.
- **Sanity kết cục**: run `is_error`/thiếu usage bị loại tự động; run ra kết cục khác
  expectHint của scenario (vd S1 lại dừng hỏi) thì tự loại tay — khác kết cục là khác kịch
  bản, không được lấy trung bình chung.
- Nhiễu còn lại là nondeterminism của model (±10–30% giữa các run hợp lệ) → dùng **median
  của N≥3**, pin `--model`, một lần đo đừng đổi máy/network giữa chừng.
- Muốn tách "chi phí của skill" khỏi "chi phí agent nói chung": chạy cùng corpus trên máy
  không cài plugin làm baseline rồi trừ.
