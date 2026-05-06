"""
Cookie Chat API — Python Example
=================================
Gọi API từ Python để gửi prompt kèm cookie Facebook.

Cài đặt: pip install requests
"""

import requests

# Thay bằng URL thực của bạn sau khi deploy lên Railway
API_URL = "https://your-app.railway.app/api/chat"

# ── 1. Gửi tin nhắn đầu tiên với cookie ──────────────────────────────────
cookies = "c_user=YOUR_C_USER; xs=YOUR_XS; datr=YOUR_DATR; fr=YOUR_FR; sb=YOUR_SB"

response = requests.post(API_URL, json={
    "cookies": cookies,
    "prompt": "Xin chào! Bạn có thể giúp tôi không?",
    "system_prompt": "Bạn là trợ lý AI hữu ích, thân thiện. Trả lời bằng tiếng Việt.",
})

data = response.json()
print("=== Tin nhắn 1 ===")
print("Reply:", data["reply"])
print("Session ID:", data["session_id"])
print("Cookie keys:", data["cookie_keys"])
print("Model:", data["model"])
print()

# ── 2. Tiếp tục hội thoại (dùng session_id, không cần gửi cookie lại) ────
session_id = data["session_id"]

response2 = requests.post(API_URL, json={
    "session_id": session_id,
    "prompt": "Hãy giải thích machine learning là gì một cách đơn giản.",
})
print("=== Tin nhắn 2 ===")
print("Reply:", response2.json()["reply"])
print("History length:", response2.json()["history_length"])
print()

# ── 3. Kiểm tra thông tin session ─────────────────────────────────────────
session_info = requests.get(f"{API_URL.replace('/chat', '/chat/session')}/{session_id}")
print("=== Thông tin Session ===")
print(session_info.json())
print()

# ── 4. Reset / xóa session ───────────────────────────────────────────────
reset = requests.post(API_URL.replace("/chat", "/chat/reset"), json={
    "session_id": session_id
})
print("=== Reset ===")
print(reset.json())
