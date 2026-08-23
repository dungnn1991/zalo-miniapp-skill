# create-zmp-app

[English](./README.md) | **Tiếng Việt**

Tạo, phát triển, kiểm chứng và triển khai Zalo Mini Apps bằng Codex hoặc Claude Code.

`create-zmp-app` biến một mô tả tự nhiên cùng Mini App ID thành project có thể chạy và tiếp tục
phát triển. Agent tự chọn starter hoặc template đã được kiểm chứng, gắn đúng App ID, cài dependency,
build, kiểm tra giao diện trong trình duyệt và mở preview. Khi được yêu cầu, agent có thể chạy giả
lập API Zalo hoặc deploy bản đã verify lên Development/Testing.

## Khả năng

- Tạo Mini App mới từ prompt tiếng Việt có dấu, không dấu hoặc tiếng Anh.
- Tiếp tục phát triển project hiện có mà không scaffold đè lên code đã sửa.
- Tích hợp tính năng dựa trên tài liệu Zalo Mini App đang public.
- Build và kiểm tra render ở nhiều kích thước màn hình, kèm evidence và chẩn đoán lỗi.
- Chạy simulator để thử các flow được hỗ trợ trước khi UAT trên Zalo thật.
- Deploy Development/Testing khi user yêu cầu rõ và bản build đã qua verify.

## Cài đặt

### Claude Code

```text
/plugin marketplace add dungnn1991/zalo-miniapp-skill
/plugin install create-zmp-app@zalo-miniapp-skill
```

Cập nhật về sau bằng `/plugin update create-zmp-app`.

### Codex

```bash
curl -fsSL https://raw.githubusercontent.com/dungnn1991/zalo-miniapp-skill/main/install.sh | bash
```

Máy cần Node.js 20 trở lên và Google Chrome. `zmp-cli` chỉ cần khi deploy. Cách cài cho cả hai
host, pin version hoặc dùng kênh staging nằm trong
[hướng dẫn cài đặt và tích hợp](./skill/create-zmp-app/HUONG-DAN-TICH-HOP.md).

## Bắt đầu nhanh

Mở Codex hoặc Claude Code trong thư mục muốn tạo app rồi nhập:

```text
tạo Zalo Mini App bán quần áo với appId=2607885...
```

Agent sẽ tự chạy toàn bộ pipeline và mở preview sau khi các bước kiểm chứng hoàn tất. Mini App ID
lấy tại [Zalo Mini App Developers](https://miniapp.zaloplatforms.com/developers); nếu prompt chưa
có ID hoặc xung đột với project hiện tại, agent sẽ dừng trước khi sửa source và hỏi lại.

Một số yêu cầu thường dùng:

| Bạn muốn | Prompt mẫu |
|---|---|
| Tạo app mới | `tạo Zalo Mini App bán quần áo với appId=...` |
| Dùng template đã support | `tạo app thời trang dùng mẫu zaui-fashion, appId=...` |
| Thêm tính năng vào app hiện có | `tích hợp đăng nhập Zalo vào nút Thông tin tài khoản` |
| Chạy thử flow được hỗ trợ | `chạy giả lập, cho tôi thử flow xin quyền` |
| Deploy Development | `deploy bản development` |
| Deploy Testing | `deploy testing với mô tả "bản kiểm thử sprint 3"` |
| Chẩn đoán lỗi | `app đang lỗi Network Error, kiểm tra giúp` |

## Template

[ZaUI Templates](https://miniapp.zaloplatforms.com/zaui-templates) hiện công bố chín template.
Mọi brief đều được chấm điểm với danh sách này, user không cần nói "dùng mẫu có sẵn"; nhưng skill
chỉ scaffold những revision đã đi qua qualification gate riêng để bảo đảm cài, build và render tái
hiện được. Template đang đạt chuẩn nằm trong `skill/create-zmp-app/catalog/templates.json`; brief
không có mẫu nào phù hợp sẽ dùng neutral starter, kèm báo cáo nói rõ ứng viên nào bị loại và vì sao.

Cách chọn template nằm ở
[Template routing](./skill/create-zmp-app/references/template-routing.md), cơ chế scaffold nằm ở
[Official templates](./skill/create-zmp-app/references/official-templates.md).

## Chất lượng và an toàn

- Mini App ID được giữ nguyên chính xác và kiểm tra lại từ source đến build.
- Safe rerun bảo vệ code user đã sửa; ghi đè luôn cần lựa chọn rõ ràng.
- Simulator được gắn nhãn `SIMULATOR`; kết quả mock không được báo như UAT thật.
- Deploy không tự chạy sau build và không đọc hoặc đưa token đăng nhập vào log/evidence.
- Mỗi run lưu kết quả verify, screenshot và finding để có thể kiểm tra lại.

## Tài liệu

| Nội dung | Liên kết |
|---|---|
| Cài đặt, version và cách gọi skill | [Hướng dẫn tích hợp](./skill/create-zmp-app/HUONG-DAN-TICH-HOP.md) |
| Workflow và guardrail mà agent tuân theo | [SKILL.md](./skill/create-zmp-app/SKILL.md) |
| Tích hợp tính năng Zalo | [Feature recipes](./skill/create-zmp-app/references/feature-recipes.md) |
| Template chính thức | [Official templates](./skill/create-zmp-app/references/official-templates.md) |
| Simulator | [Simulator workflow](./skill/create-zmp-app/references/simulator-workflow.md) |
| Deploy Development/Testing | [Deploy workflow](./skill/create-zmp-app/references/deploy-workflow.md) |
| Tra lỗi build, runtime và CORS | [Troubleshooting](./skill/create-zmp-app/references/troubleshooting.md) |
| Vận hành, quyền và môi trường | [Operations](./skill/create-zmp-app/references/operations.md) |
| Thay đổi theo phiên bản | [Changelog](./skill/create-zmp-app/CHANGELOG.md) |

## Phát triển skill

Repo này chứa runtime skill và lab kiểm chứng. Release gate chạy metadata validator, routing
corpus và bộ 36 case bằng:

```bash
npm test
```

Đọc [LAB.md](./LAB.md) trước khi sửa contract hoặc pipeline. Thay đổi đi qua `staging`, chỉ merge
`main` và tạo tag khi release gate xanh.

## Nguồn chính thức

- [Tài liệu Zalo Mini App](https://docs.zaloplatforms.com/docs/MA)
- [Zalo Mini App Center](https://miniapp.zaloplatforms.com/)
