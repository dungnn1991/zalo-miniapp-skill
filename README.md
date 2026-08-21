# create-zmp-app — Tạo Zalo Mini App bằng một câu prompt

Skill cho AI agent (Claude Code, Codex...): bạn mô tả app bằng lời, agent tự **scaffold → build
→ kiểm chứng render thật trên 3 cỡ màn hình → mở bản xem thử** — và khi bạn yêu cầu, **giả lập
API Zalo (flow xin quyền)** hoặc **deploy lên Development/Testing**. Bạn không phải gõ lệnh nào.

## Cài đặt (chọn 1 trong 2 cách)

**Cách 1 — Claude Code** (khuyên dùng, kể cả bạn không phải dev). Gõ 2 lệnh trong Claude Code:

```
/plugin marketplace add dungnn1991/zalo-miniapp-skill
/plugin install create-zmp-app@zalo-miniapp-skill
```

Sau này cập nhật: `/plugin update create-zmp-app`.

**Cách 2 — Một dòng terminal** (Codex hoặc host khác):

```bash
curl -fsSL https://raw.githubusercontent.com/dungnn1991/zalo-miniapp-skill/main/install.sh | bash
```

Máy cần sẵn: **Node ≥ 20** và **Google Chrome**. Không cần cài gì thêm — lần chạy đầu skill tự
cài dependency (`doctor`). Riêng khi deploy mới cần `zmp-cli` (`npm i -g zmp-cli`).

## Dùng ngay — chỉ cần gõ prompt

| Bạn muốn | Gõ (ví dụ) |
|---|---|
| Tạo app theo mô tả | `tạo app bán quần áo với appId=2607885...` |
| Tạo từ mẫu chính thức của Zalo | `tạo app cà phê dùng mẫu có sẵn, appId=...` |
| Xem app + thử flow xin quyền (không cần Zalo) | `chạy giả lập, cho tôi bấm thử flow xin quyền` |
| Thêm tính năng vào app đã tạo | `tích hợp đăng nhập Zalo vào nút Thông tin tài khoản` |
| Deploy bản Development | `deploy bản development` |
| Deploy bản Testing (đánh số version) | `deploy testing với mô tả "demo sprint 3"` |
| App đang lỗi, nhờ chẩn đoán | `app đang lỗi Network Error, check giúp` |

- Prompt viết **tiếng Việt có dấu, không dấu hay tiếng Anh đều được** ("tao app dat mon cho
  quan an" = "create a food ordering app").
- **App ID** lấy ở đâu? Tạo Mini App trên https://mini.zalo.me/developers rồi copy ID vào
  prompt. Không có ID trong prompt, agent sẽ dừng lại hỏi bạn — skill **không bao giờ tự bịa ID**.
- Bạn chỉ phải làm 3 việc: gõ prompt · **quét QR bằng Zalo** khi deploy · trả lời khi agent hỏi
  (App ID, chọn mẫu, xác nhận deploy). Mọi thứ còn lại agent chạy ngầm.

Sau khi build xong, agent **tự mở cửa sổ Chrome cỡ điện thoại** cho bạn xem app, kèm báo cáo
kết quả + gợi ý bước tiếp theo. Bản giả lập có **bottomsheet xin quyền với badge `SIMULATOR`**
— đồng ý/từ chối đều ra đúng hành vi và mã lỗi như Zalo thật (dữ liệu là mock).

## Version — đọc kỹ để khỏi mất thời gian check bug sai bản

- Cài mặc định luôn lấy **bản release mới nhất** (tag `vX.Y.Z` trên nhánh `main`), không bao
  giờ lấy code lửng lơ. Cần đúng một bản cụ thể: `... | bash -s -- --version v0.3.0`.
- Mỗi lần chạy, skill in `doctor: ok — create-zmp-app v0.3.0 (v0.3.0)`. Bản copy tay sẽ hiện
  `(dev copy)`. **Báo bug bắt buộc kèm dòng này** (hoặc `cat <thư-mục-skill>/INSTALLED_VERSION`).
- Nhánh `staging` = thử nghiệm liên tục, chỉ dành cho team dev — đừng dùng để demo.

---

## Tra cứu lỗi

Skill tự chẩn đoán phần lớn lỗi (khớp "chữ ký lỗi" → đính kèm nguyên nhân + cách sửa vào báo
cáo). Gặp lỗi cứ hỏi agent: *"app lỗi ..., check giúp"*. Bảng dưới để bạn tra nhanh.

### A. Trạng thái pipeline (exit code khi agent chạy skill)

| Code | Nghĩa | Bạn cần làm gì |
|---|---|---|
| `0` | Thành công | Không gì cả — xem báo cáo |
| `1` | Một bước kiểm chứng fail (đã ghi finding + evidence) | Đọc chẩn đoán agent đưa; thường kèm luôn cách sửa |
| `2` | Cần bạn cung cấp thông tin — **chưa có gì bị thay đổi** | Trả lời câu agent hỏi: thiếu App ID · App ID trong prompt khác với app hiện có (chọn 1) · cần đăng nhập zmp-cli (quét QR) |
| `3` | Lỗi môi trường/cách gọi (thiếu Node/Chrome, tham số sai) — riêng trạng thái `needs_template_choice` nghĩa là bạn muốn "mẫu có sẵn" nhưng chưa rõ mẫu nào | Làm theo hướng dẫn in kèm; với template: chọn 1 mẫu trong danh sách agent liệt kê |

### B. Mã lỗi API Zalo (khi app chạy — thật lẫn giả lập)

| Mã | Nghĩa | Xử lý |
|---|---|---|
| `-201` | Người dùng **từ chối** cấp quyền (getUserInfo/getLocation/getPhoneNumber...) | Hành vi hợp lệ — app nên hiện thông báo thân thiện, **đừng hỏi lặp lại**; muốn bật lại hướng người dùng vào `openPermissionSetting`. Recipe của skill đã xử lý sẵn |
| `-202`, `-2002` | Từ chối kèm "không hỏi lại" | Như trên — chỉ còn đường `openPermissionSetting` |
| `-1401` | Chưa đăng nhập / chưa được cấp quyền (`LOGIN_REQUIRED` / `NEED_USER_AUTH`) | Trong app: gọi đúng thứ tự `getSetting → authorize → API` (recipe có sẵn). Trong giả lập: đã mock tự động |
| `-1404` | Phiên bản Zalo không hỗ trợ API này (`CLIENT_NOT_SUPPORT`) | Máy thật: cập nhật app Zalo. Trong giả lập: skill đã xử lý (host hooks) — gặp lại là bug, báo kèm version |
| `-2000` + `api:"login"` | SDK tự gọi login ngoài môi trường Zalo (mở bằng browser thường) | Bình thường khi xem bản build ngoài Zalo — template của skill đã có guard; app render vẫn ổn |
| `-1400` | Request/app-config không hợp lệ | Kiểm tra `app-config.json`; chạy lại pipeline để verify |
| `-1408` | API timeout | Thử lại; mạng/thiết bị |
| Token của `getLocation`/`getPhoneNumber` | **Không phải** tọa độ/số điện thoại — là token phải decode ở **server của bạn** | Gọi API decode từ backend (kèm secret key) — gọi từ client là lỗ hổng bảo mật, skill sẽ chặn khi quét code |

### C. Lỗi deploy & vận hành thường gặp

| Thông điệp | Nguyên nhân | Cách sửa |
|---|---|---|
| `Permission denied. Please login again.` | Chưa/hết hạn đăng nhập zmp-cli; hoặc trong CI: token không khớp app (nhầm `MINI_APP_ID` với `ZALO_APP_ID`, `ZMP_TOKEN` bị env đè) | Agent sẽ tự đưa QR cho bạn quét lại. CI: kiểm tra 3 bẫy vừa nêu |
| `You have reached your 30-day deployment limit` | Hết quota: **300 lần/tháng (Development)**, **60 lần/tháng (Testing)** | Chờ chu kỳ sau; skill có ghi quota còn lại vào báo cáo mỗi lần deploy |
| `output folder www was not found` (Vite 5) | `vite.config` thiếu/`zmp-vite-plugin` cấu hình sai | App do skill tạo không dính lỗi này; app cũ: thêm `zmp-vite-plugin` vào plugins |
| `Trang này không tìm thấy hoặc không hợp lệ` | Mở bản Development/Testing bằng tài khoản **không phải** Developer/Admin của app | Đăng nhập đúng tài khoản, hoặc dùng bản Live |
| `Ứng dụng đang trong giai đoạn phát triển` | App chưa có bản Live mà mở link Live | Deploy + xét duyệt trước, hoặc mở bản Development/Testing |
| `Network Error` khi app gọi API của bạn | 99% là **CORS — lỗi phía server của bạn**, không phải Mini App | Server trả `Access-Control-Allow-Origin: https://h5.zdn.vn` (đúng MỘT origin, trả cả cho preflight `OPTIONS`); URL phải `https://` + SSL còn hạn, không dùng IP trần |
| `Minified React error #...` | Bug React trong code (sai rule hooks, setState khi render...) | Mở link trong thông báo lỗi để xem nội dung đầy đủ rồi sửa |
| `Transforming ... to "es2015" is not supported` | Thư viện dùng cú pháp JS mới hơn target mặc định | Nâng `build.target` trong vite.config (giảm tương thích máy cũ) hoặc thay thư viện |
| `The file size is too large` | Vượt giới hạn **10MB/app, 3MB/file** | Ảnh/video đưa lên CDN; script nặng thì code-splitting. Skill đã chặn trước khi deploy |

**Lưu ý môi trường quan trọng:** flow xin quyền thật chỉ áp dụng khi app **Live** (đã qua kiểm
duyệt) — bản Development/Testing không hiện form quyền. Vì vậy muốn thử flow quyền trước khi
Live, dùng **giả lập của skill** (mock đúng hành vi Live). Bản Development chỉ có MỘT slot (bản
sau đè bản trước); bản Testing được đánh số version bền — cần link ổn định để test thì dùng Testing.

---

## Nâng cao

**Tuỳ chọn cài đặt** (`install.sh`):

```bash
--version vX.Y.Z   # pin đúng version (git tag)
--channel staging  # theo nhánh thử nghiệm
--codex <dir>      # cài thêm cho Codex host
--dest <dir>       # đổi thư mục đích (mặc định ~/.claude/skills)
```

**Chạy tay từng phần** (bình thường agent tự làm — chỉ dùng khi debug):

```bash
S=<thư-mục-skill>/scripts
node $S/run.mjs --brief "tạo app bán quần áo" --app-id <ID> \
  [--template official:<id>] [--verify-sim] [--preview-sim] [--sim-decision accept|deny|manual] \
  [--deploy | --deploy-testing] [--desc "..."] [--preview] [--workspace <dir>]
node $S/preview.mjs --run-id <id> [--sim] [--desktop]   # mở lại bản xem thử
```

Toàn bộ hợp đồng chi tiết (workflow, guardrails, schema, mock data): đọc
[`skill/create-zmp-app/SKILL.md`](./skill/create-zmp-app/SKILL.md) và
[`skill/create-zmp-app/HUONG-DAN-TICH-HOP.md`](./skill/create-zmp-app/HUONG-DAN-TICH-HOP.md).
Lịch sử thay đổi: [`skill/create-zmp-app/CHANGELOG.md`](./skill/create-zmp-app/CHANGELOG.md).

**Dành cho dev đóng góp:** repo này đồng thời là lab phát triển (case suite 28 kịch bản, vòng
finding → improvement → regression). Đọc [`LAB.md`](./LAB.md). Quy trình nhánh: mọi thay đổi
vào `staging`; đủ xanh thì bump version + CHANGELOG + merge `main` + tag.
