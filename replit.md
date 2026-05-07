# Cookie Chat API

API server nhận cookie Facebook + prompt, gọi AI và trả về reply. Có thể gọi từ Python hoặc dùng giao diện web.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — chạy API server (port từ env PORT)
- `pnpm --filter @workspace/cookie-api run dev` — chạy frontend web
- `pnpm run typecheck` — kiểm tra kiểu toàn bộ workspace
- `pnpm --filter @workspace/api-spec run codegen` — tái tạo hooks từ OpenAPI spec
- `pnpm --filter @workspace/db run push` — push schema DB (dev only)

**Env vars cần thiết (ít nhất 1 AI key):**
- `ANTHROPIC_API_KEY` — Anthropic Claude (trả phí)
- `GITHUB_TOKEN` — GitHub Models miễn phí
- `AI_BASE_URL` + `AI_API_KEY` — OpenRouter / custom endpoint
- `AI_MODEL` — (tùy chọn) override model name

## Stack

- **Monorepo**: pnpm workspaces, Node.js 24, TypeScript 5.9
- **API**: Express 5 + esbuild
- **Frontend**: React + Vite + Tailwind CSS
- **AI**: Anthropic SDK / OpenAI-compat (multi-provider)
- **DB**: PostgreSQL + Drizzle ORM (không dùng trong chat endpoint)
- **Validation**: Zod

## Where things live

- `artifacts/api-server/src/routes/chat.ts` — endpoint `/api/chat`, `/api/chat/reset`, `/api/chat/session/:id`
- `artifacts/api-server/src/routes/bot.ts` — Facebook bot routes
- `artifacts/cookie-api/src/pages/ChatPage.tsx` — UI web chat
- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth)
- `example_python.py` — ví dụ gọi API từ Python

## Architecture decisions

- Chat endpoint tự quản lý AI client (không dụ thuộc `bot/claude.ts`) để tránh crash khi không có key
- Session lưu in-memory (Map), tự dọn sau 2 giờ không dùng
- Cookie chỉ cần gửi 1 lần → server giữ trong session, lần sau dùng `session_id`
- `claude.ts` warn thay vì throw khi thiếu AI key, để server khởi động được

## Product

- POST `/api/chat` — nhận cookie + prompt → AI reply (tạo session mới hoặc dùng lại)
- POST `/api/chat/reset` — xóa session
- GET `/api/chat/session/:id` — xem thông tin session
- Giao diện web tại `/` để test nhanh mà không cần viết code
- `example_python.py` — mẫu Python sẵn dùng

## Gotchas

- Cần ít nhất 1 AI key trong env, server sẽ warn nếu thiếu nhưng vẫn khởi động
- Cookie phải có `xs` và `c_user` để bot Facebook hoạt động (chat API không bắt buộc)
- Trên Railway: thêm env vars qua Railway dashboard, không hardcode

## User Preferences

- Sau mỗi thay đổi code, **tự động push lên GitHub** (`ledonghahbhs1-dot/fb_re`) bằng GITHUB_TOKEN mà không cần nhắc nhở.
