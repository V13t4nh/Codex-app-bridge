# Telegram -> Codex Desktop RPA Bridge

Bridge là một dự án Node.js + TypeScript giúp điều khiển Codex Desktop từ xa qua Telegram hoặc qua CLI local. Phần lõi kết nối vào giao diện Codex bằng Playwright CDP, gửi prompt, chờ Codex trả lời xong và trả lại nội dung mới nhất cho adapter đang dùng.

## Mục tiêu

- Dùng Telegram như một giao diện từ xa cho Codex Desktop đang chạy trên máy Windows.
- Cho phép kiểm thử end-to-end local mà không cần Telegram token.
- Tách lõi bridge khỏi adapter để có thể thêm kênh khác ngoài Telegram.
- Cung cấp script doctor, mock E2E và benchmark để kiểm tra nhanh cấu hình.

## Kiến trúc

- `src/core`: kết nối Codex Desktop qua `chromium.connectOverCDP`, tìm input/nút gửi/khu vực phản hồi, gửi prompt và đọc phản hồi.
- `src/adapters/telegram.ts`: xử lý bot Telegram bằng grammY, kiểm soát user được phép dùng, chia nhỏ phản hồi dài, hiển thị trạng thái đang nghĩ và hỗ trợ chọn workspace/thread.
- `src/adapters/local.ts`: chạy prompt trực tiếp qua bridge để kiểm thử không cần Telegram.
- `src/cli`: các lệnh kiểm tra cấu hình, E2E, benchmark và kiểm tra Telegram token.

## Yêu cầu

- Windows 10/11.
- Node.js 20 trở lên.
- npm.
- Codex Desktop hoặc một bề mặt Codex dựa trên Chromium được mở với remote debugging.

## Cài đặt

```powershell
cd D:\project\bridge
npm install
copy .env.example .env
```

Không commit file `.env`. File `.env.example` là mẫu cấu hình an toàn để đưa vào repo.

## Cấu hình môi trường

| Biến | Bắt buộc | Mặc định | Mô tả |
| --- | --- | --- | --- |
| `CODEX_CDP_URL` | Không | `http://127.0.0.1:9222` | URL CDP của Codex Desktop/Chromium. |
| `TELEGRAM_BOT_TOKEN` | Chỉ khi chạy Telegram | Trống | Token bot Telegram từ BotFather. Nếu trống, Telegram bị tắt. |
| `TELEGRAM_ALLOWED_USER_IDS` | Có khi có token | Trống | Danh sách Telegram user ID được phép dùng bot, phân tách bằng dấu phẩy. |
| `LOG_LEVEL` | Không | `info` | Một trong `debug`, `info`, `warn`, `error`. |
| `CODEX_TIMEOUT_MS` | Không | `1800000` | Thời gian tối đa chờ Codex rảnh hoặc trả lời xong. Mặc định 30 phút. |
| `CODEX_WORKSPACE_NAME` | Không | Trống | Workspace Codex cần chọn trước khi gửi prompt. |
| `CODEX_CHAT_MODE` | Không | `current` | `current` để dùng thread hiện tại, `new` để tạo chat mới trước mỗi prompt. |

Ví dụ `.env` tối thiểu:

```env
CODEX_CDP_URL=http://127.0.0.1:9222
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_IDS=
LOG_LEVEL=info
CODEX_TIMEOUT_MS=1800000
CODEX_WORKSPACE_NAME=
CODEX_CHAT_MODE=current
```

## Mở Codex Desktop với CDP

Đóng các cửa sổ Codex/Chromium đang chạy, sau đó mở lại với cổng remote debugging:

```powershell
& "C:\Path\To\Codex.exe" --remote-debugging-port=9222
```

Nếu đang phát triển bằng Chrome hoặc Edge, dùng cùng cờ `--remote-debugging-port=9222`:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

Giữ trang Codex mở trước khi chạy `doctor` hoặc E2E.

## Script npm

| Lệnh | Mục đích |
| --- | --- |
| `npm run dev` | Build TypeScript rồi chạy bot Telegram nếu có `TELEGRAM_BOT_TOKEN`. |
| `npm run start` | Chạy bản đã build tại `dist/index.js`. |
| `npm run build` | Biên dịch TypeScript ra `dist`. |
| `npm run typecheck` | Kiểm tra TypeScript với `--noEmit`. |
| `npm test` | Chạy unit test bằng Vitest. |
| `npm run doctor` | Kiểm tra Node/npm/env/CDP/trang Codex/selector. |
| `npm run e2e:local -- "Say exactly: bridge-ok"` | Gửi prompt thật vào Codex Desktop qua CDP. |
| `npm run e2e:telegram:mock` | Kiểm thử handler Telegram bằng bot/context giả lập. |
| `npm run benchmark:local -- --count=3` | Đo latency nhiều lượt qua Codex Desktop thật. |
| `npm run telegram:check` | Kiểm tra token Telegram và đăng ký menu lệnh. |

## Chạy không cần Telegram

Đây là luồng kiểm thử nên dùng trong quá trình phát triển:

```powershell
npm run doctor
npm run e2e:local -- "Say exactly: bridge-ok"
```

`e2e:local` gửi prompt vào Codex Desktop thật qua Playwright CDP, chờ tối đa theo `CODEX_TIMEOUT_MS`, in phản hồi ra terminal và trả exit code khác 0 nếu thất bại.

Bridge coi Codex là đang bận khi thấy nút Stop/Pause hoặc tín hiệu tool activity. Sau khi Codex idle, bridge tiếp tục chờ text phản hồi ổn định trước khi trả kết quả. Nếu timeout xảy ra, bridge chỉ báo lỗi cho adapter; nó không tự bấm Stop/Pause trên Codex.

## Chạy Telegram bot

Tạo bot bằng BotFather, sau đó cập nhật `.env`:

```env
TELEGRAM_BOT_TOKEN=<token-that-khong-commit>
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

Khi `TELEGRAM_BOT_TOKEN` được đặt, `TELEGRAM_ALLOWED_USER_IDS` phải có ít nhất một ID hợp lệ. Bot sẽ fail closed nếu thiếu danh sách này vì Telegram có thể điều khiển phiên Codex Desktop local.

Chạy bot:

```powershell
npm run dev
```

Các lệnh Telegram:

- `/start`: kiểm tra quyền và báo bot sẵn sàng.
- `/workspace`: mở menu chọn workspace; chọn workspace sẽ đổi route ngay, sau đó có thể chọn thread hoặc `+ New`.
- `/stop`: bấm Stop/Pause nếu tìm thấy trên giao diện Codex.
- `/status`: hiển thị route Telegram hiện tại và trạng thái workspace Codex.
- `/clear`: xóa route Telegram trong session hiện tại.
- `/clear_all`: reset route/session và cố xóa các message gần nhất trong chat Telegram với bot. Telegram không có API xóa toàn bộ lịch sử tùy ý, nên các message quá cũ hoặc message Telegram không cho bot xóa có thể còn lại. Khi Telegram báo đã tới vùng message không xóa được, bridge dừng quét để tránh spam log/API.
- Tin nhắn text thông thường: chuyển tiếp prompt sang Codex Desktop, bao gồm prompt bắt đầu bằng `$` để gọi skill của Codex. Bot gửi một dòng emoji trạng thái trong lúc Codex đang xử lý, rồi tự xóa khi có phản hồi nếu Telegram cho phép.
- Skill alias: khi khởi động, bot tự dò các skill local trong `%USERPROFILE%\.codex\skills` và `%USERPROFILE%\.agents\skills`, rồi đăng ký slash alias hợp lệ cho Telegram. Ví dụ skill `frontend-ui-ux` xuất hiện trong Telegram menu là `/frontend_ui_ux`; khi dùng alias này, bridge gửi sang Codex thành `$frontend-ui-ux ...`.
- File document Telegram: tải file về `.omc/telegram-files`, rồi gửi local path và caption sang Codex để dùng làm ngữ cảnh.

Adapter gom các tin nhắn text liên tiếp rất nhanh của cùng user trong khoảng 1 giây thành một prompt nhiều dòng. Việc này giúp các client tách Shift+Enter/thao tác xuống dòng thành nhiều message vẫn được gửi sang Codex như một cụm.

## Troubleshooting

Chạy:

```powershell
npm run doctor
```

Các lỗi thường gặp:

- `CDP unreachable`: Codex chưa được mở với `--remote-debugging-port=9222` hoặc cổng đang bị ứng dụng khác chiếm.
- `No pages open`: CDP kết nối được nhưng chưa có trang Codex đang mở.
- `Input selector not found`: chạy `doctor`, đọc mẫu DOM/ARIA và cập nhật fallback selector trong `src/core/selectorConfig.ts`.
- `Timeout waiting for response`: Codex chưa trả lời trong thời gian `CODEX_TIMEOUT_MS` hoặc giao diện vẫn còn tín hiệu Stop/Pause/Running.
- Telegram báo `Access denied`: user ID chưa nằm trong `TELEGRAM_ALLOWED_USER_IDS`.

## Kiểm tra trước khi bàn giao

```powershell
npm install
npm run typecheck
npm test
npm run build
npm run doctor
npm run e2e:local -- "Say exactly: bridge-ok"
npm run e2e:telegram:mock
npm run benchmark:local -- --count=3
```

`doctor`, `e2e:local` và `benchmark:local` cần Codex Desktop thật đang mở với CDP. Nếu chưa cấu hình Telegram token thì bỏ qua smoke test Telegram thật, nhưng vẫn nên chạy `e2e:telegram:mock`.

## Ghi chú về Git

`.gitignore` đã bỏ qua dependency, output build, file môi trường, log, coverage, artifact Playwright/Vitest và state local của tool. Vẫn giữ `package-lock.json` và `.env.example` để repo có thể cài đặt lặp lại và có mẫu cấu hình rõ ràng.
