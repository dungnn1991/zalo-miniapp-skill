# create-zmp-app

Skill dựng Zalo Mini App từ một câu mô tả, dành cho các AI agent như Claude Code hay Codex.
Bạn nói muốn app gì kèm App ID, agent lo phần còn lại: sinh source, cài dependency, build bằng
Vite, mở trình duyệt kiểm tra app render đúng ở ba cỡ màn hình, rồi để sẵn một cửa sổ xem thử.
Khi bạn yêu cầu, agent chạy tiếp phần giả lập API Zalo hoặc deploy lên bản Development/Testing.

## Cài đặt

Dùng Claude Code thì cài qua marketplace:

```
/plugin marketplace add dungnn1991/zalo-miniapp-skill
/plugin install create-zmp-app@zalo-miniapp-skill
```

Cập nhật về sau bằng `/plugin update create-zmp-app`.

Dùng Codex hoặc host khác thì chạy một dòng trong terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/dungnn1991/zalo-miniapp-skill/main/install.sh | bash
```

Máy cần Node 20 trở lên và Google Chrome. Dependency riêng của skill do lần chạy đầu tự cài nên
bạn không phải chuẩn bị gì thêm; chỉ khi nào deploy mới cần `zmp-cli` (`npm i -g zmp-cli`).

## Bắt đầu

Mở session agent rồi gõ yêu cầu, tiếng Việt hay tiếng Anh, có dấu hay không dấu đều nhận:

| Mục đích | Ví dụ |
|---|---|
| Tạo app theo mô tả | `tạo app bán quần áo với appId=2607885...` |
| Tạo từ mẫu chính thức của Zalo | `tạo app cà phê dùng mẫu có sẵn, appId=...` |
| Xem app và thử luồng xin quyền mà không cần Zalo | `chạy giả lập, cho tôi bấm thử flow xin quyền` |
| Thêm tính năng vào app đã có | `tích hợp đăng nhập Zalo vào nút Thông tin tài khoản` |
| Đưa lên bản Development | `deploy bản development` |
| Đưa lên bản Testing kèm mô tả version | `deploy testing với mô tả "demo sprint 3"` |
| Nhờ chẩn đoán lỗi | `app đang lỗi Network Error, check giúp` |

App ID lấy tại https://mini.zalo.me/developers sau khi tạo Mini App. Prompt thiếu ID thì agent
dừng lại hỏi chứ không tự sinh giá trị nào; ID trong prompt khác với ID đang gắn trong project
thì agent cũng dừng để bạn chọn giữ cái nào.

Phần bạn tự tay làm chỉ gồm ba việc: gõ prompt, quét QR bằng Zalo lúc deploy, và trả lời khi
agent hỏi. Mọi lệnh build, kiểm chứng, ghi bằng chứng đều chạy ngầm.

Build xong agent mở một cửa sổ Chrome cỡ điện thoại kèm báo cáo kết quả và gợi ý bước kế tiếp.
Bản giả lập có bottomsheet xin quyền gắn nhãn `SIMULATOR`; đồng ý hay từ chối đều trả về đúng
hành vi và mã lỗi như trên Zalo thật, chỉ dữ liệu là giả.

## Phiên bản

Lệnh cài mặc định lấy tag mới nhất trên nhánh `main`, không bao giờ lấy code lửng lơ giữa hai
lần release. Cần đúng một bản cụ thể thì chỉ định rõ:

```bash
curl -fsSL https://raw.githubusercontent.com/dungnn1991/zalo-miniapp-skill/main/install.sh | bash -s -- --version v0.3.0
```

Mỗi lần chạy, skill in ra dòng `doctor: ok — create-zmp-app v0.3.0 (v0.3.0)`; bản copy tay sẽ
hiện `(dev copy)` thay cho tag. Báo lỗi nhớ kèm dòng này hoặc nội dung file `INSTALLED_VERSION`
trong thư mục skill, tránh cảnh hai bên soi bug trên hai bản khác nhau.

Nhánh `staging` là nơi thử nghiệm liên tục, thay đổi bất cứ lúc nào. Team dev cài bằng
`--channel staging`, còn demo cho người khác thì dùng `main`.

## Tra lỗi

Agent tự nhận diện phần lớn lỗi quen thuộc và đính kèm nguyên nhân lẫn cách sửa ngay trong báo
cáo, nên cách nhanh nhất vẫn là mô tả lại lỗi cho agent. Các bảng dưới dành cho lúc bạn muốn tự
tra cứu.

### Exit code của pipeline

| Code | Ý nghĩa | Cần làm gì |
|---|---|---|
| `0` | Chạy xong, mọi gate đều pass | Đọc báo cáo là đủ |
| `1` | Một bước kiểm chứng thất bại, finding và evidence đã được ghi lại | Xem chẩn đoán agent đưa ra, thường kèm sẵn hướng sửa |
| `2` | Thiếu thông tin từ bạn, chưa có gì bị thay đổi trên đĩa | Trả lời câu agent hỏi: cấp App ID, chọn ID khi có xung đột, hoặc quét QR đăng nhập zmp-cli |
| `3` | Sai môi trường hoặc sai tham số: thiếu Node, thiếu Chrome, flag không hợp lệ | Làm theo hướng dẫn in kèm |

Trạng thái `needs_template_choice` cũng trả code `3` nhưng không phải lỗi: bạn muốn dùng mẫu có
sẵn mà mô tả chưa đủ rõ để chọn, agent sẽ liệt kê danh sách mẫu cho bạn chỉ định.

### Mã lỗi API Zalo

Các mã này xuất hiện cả khi chạy thật lẫn trong giả lập, vì phần mock trả về đúng mã của nền tảng.

| Mã | Ý nghĩa | Xử lý |
|---|---|---|
| `-201` | Người dùng từ chối cấp quyền cho `getUserInfo`, `getLocation`, `getPhoneNumber`... | Đây là trạng thái hợp lệ chứ không phải sự cố. App nên báo nhẹ nhàng rồi dừng, đừng hỏi lại liên tục; muốn mở lại thì dẫn người dùng sang `openPermissionSetting`. Recipe đăng nhập của skill đã xử lý sẵn |
| `-202`, `-2002` | Từ chối kèm lựa chọn không hỏi lại | Giống `-201` nhưng không còn cửa hỏi trực tiếp, chỉ còn đường `openPermissionSetting` |
| `-1401` | Chưa đăng nhập hoặc chưa được cấp quyền (`LOGIN_REQUIRED`, `NEED_USER_AUTH`) | Gọi đúng thứ tự `getSetting`, `authorize`, rồi mới tới API cần dùng. Trong giả lập chuỗi này đã được mock đầy đủ |
| `-1404` | Phiên bản Zalo trên máy không hỗ trợ API (`CLIENT_NOT_SUPPORT`) | Máy thật thì cập nhật Zalo. Trong giả lập skill đã set host hook để qua được, nếu vẫn gặp thì là bug của skill, báo kèm version |
| `-2000` với `api: "login"` | SDK tự gọi login khi app chạy ngoài môi trường Zalo | Bình thường khi mở bản build bằng trình duyệt thường. Template của skill có sẵn guard nên app vẫn render đúng |
| `-1400` | Request hoặc `app-config.json` không hợp lệ | Kiểm tra lại `app-config.json` rồi chạy lại pipeline |
| `-1408` | Hết thời gian chờ | Thử lại, thường do mạng hoặc thiết bị |

Một điểm hay nhầm: `getLocation` và `getPhoneNumber` không trả toạ độ hay số điện thoại mà trả
token, phải gửi về server của bạn để decode kèm secret key. Gọi thẳng API decode từ phía client
là lỗ hổng bảo mật, và skill sẽ chặn ngay ở bước quét code trước khi build.

### Lỗi lúc deploy và vận hành

| Thông báo | Nguyên nhân | Cách xử lý |
|---|---|---|
| `Permission denied. Please login again.` | Chưa đăng nhập zmp-cli hoặc token hết hạn. Trên CI thường do nhầm `MINI_APP_ID` với `ZALO_APP_ID`, hoặc biến môi trường `ZMP_TOKEN` đè lên file `.env` | Agent sẽ đưa QR mới để bạn quét. Trên CI thì rà lại ba nguyên nhân vừa nêu |
| `You have reached your 30-day deployment limit` | Hết quota deploy: 300 lượt mỗi 30 ngày cho Development, 60 lượt cho Testing | Đợi hết chu kỳ. Mỗi lần deploy skill đều ghi quota còn lại vào báo cáo |
| `output folder www was not found` | Dự án Vite 5 nhưng `vite.config` chưa khai báo `zmp-vite-plugin` | App do skill sinh ra không dính lỗi này; app cũ thì thêm plugin vào `vite.config` |
| `Trang này không tìm thấy hoặc không hợp lệ` | Mở bản Development/Testing bằng tài khoản Zalo không thuộc nhóm Developer/Admin của app | Đăng nhập đúng tài khoản, hoặc mở bản Live |
| `Ứng dụng đang trong giai đoạn phát triển` | Mở link Live trong khi app chưa có bản Live nào | Deploy và chờ duyệt, tạm thời dùng link Development/Testing |
| `Network Error` khi gọi API backend | Gần như luôn là CORS, và phải sửa ở phía server chứ không phải trong Mini App | Server trả `Access-Control-Allow-Origin: https://h5.zdn.vn`, đúng một origin duy nhất, và trả cả cho request preflight `OPTIONS`. URL phải là `https://` với SSL còn hạn, không gọi thẳng IP |
| `Minified React error #...` | Lỗi React trong code, hay gặp nhất là sai rule of hooks hoặc set state ngay lúc render | Mở link trong thông báo để xem nội dung lỗi đầy đủ |
| `Transforming ... to "es2015" is not supported` | Một thư viện dùng cú pháp mới hơn target mặc định | Nâng `build.target` trong `vite.config`, đổi lại là giảm tương thích máy cũ, hoặc thay thư viện khác |
| `The file size is too large` | Vượt giới hạn 10MB cho cả app hoặc 3MB cho một file | Đẩy ảnh và video lên CDN, script nặng thì tách bundle. Skill chặn trước khi deploy nên bạn biết sớm |

Có một điểm về môi trường nên nắm trước khi test: luồng xin quyền thật chỉ chạy khi app đã Live
và qua kiểm duyệt, bản Development hay Testing không hiện form quyền. Muốn xem trước trải nghiệm
cấp quyền thì phải dùng phần giả lập của skill. Ngoài ra bản Development chỉ có một slot, lần
deploy sau đè lên lần trước, còn bản Testing được đánh số version và giữ lại trên CDN; cần link
ổn định để test hoặc gửi cho người khác thì chọn Testing.

## Tuỳ chọn nâng cao

`install.sh` nhận thêm vài flag:

```bash
--version vX.Y.Z   # cài đúng một tag
--channel staging  # theo nhánh thử nghiệm
--codex <dir>      # cài thêm vào thư mục skill của Codex
--dest <dir>       # đổi thư mục đích, mặc định ~/.claude/skills
```

Bình thường agent tự gọi pipeline, nhưng lúc debug bạn có thể chạy tay:

```bash
S=<thư-mục-skill>/scripts

node $S/run.mjs --brief "tạo app bán quần áo" --app-id <ID> \
  [--template official:<id>] [--verify-sim] [--preview-sim] [--sim-decision accept|deny|manual] \
  [--deploy | --deploy-testing] [--desc "..."] [--preview] [--workspace <dir>]

node $S/preview.mjs --run-id <id> [--sim] [--desktop]
```

Hợp đồng đầy đủ của skill nằm trong [SKILL.md](./skill/create-zmp-app/SKILL.md): workflow,
guardrail, schema, mock data. Hướng dẫn tích hợp chi tiết ở
[HUONG-DAN-TICH-HOP.md](./skill/create-zmp-app/HUONG-DAN-TICH-HOP.md), lịch sử thay đổi ở
[CHANGELOG.md](./skill/create-zmp-app/CHANGELOG.md).

Repo này đồng thời là lab phát triển của skill, có bộ 28 case và vòng lặp
finding → improvement → regression; ai định sửa skill thì đọc [LAB.md](./LAB.md) trước. Quy ước
nhánh: mọi thay đổi vào `staging`, khi case suite xanh thì bump version, cập nhật CHANGELOG,
merge vào `main` và tag.
