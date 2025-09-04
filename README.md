# nano-banana套壳
<img width="1801" height="1734" alt="PixPin_2025-09-02_19-53-13" src="https://github.com/user-attachments/assets/d46a41f0-4892-41c4-81a3-79b032239186" />

一个本地运行的多轮对话图像生成小工具（Node.js + Express + @google/genai）。

特性
- 支持多轮会话：文本对话、图像到图像编辑/合成
- 支持一次性粘贴/发送多张图片
- 流式返回文本与图片（SSE），返回图片可一键复制到剪贴板
- 会话持久化（data/sessions），刷新不丢失；自动基于首条输入命名
- 生成与输入图片保存到 artifacts 目录（便于复用）
- 简单日志（logs/server.log，JSONL）便于排查

快速开始（Windows PowerShell）
1) 环境
- Node.js 18+（推荐 20）
- 一个 Google AI Studio API Key

2) 安装依赖
- npm install

3) 配置环境变量（请替换为你的真实密钥）
- $Env:GEMINI_API_KEY = "{{GEMINI_API_KEY}}"
可选：切换模型（不同账号/区域可用性不同）
- $Env:GENAI_MODEL = "gemini-2.5-flash-image-preview"  或  "gemini-2.5-flash" / "gemini-2.0-flash"

4) 启动开发服务
- npm run dev
- 打开 http://localhost:3000
- 输入文本、Ctrl+V 粘贴多张图片，按 Enter 或点击“发送”

目录结构（节选）
- public/index.html 前端单页（对话 UI、粘贴/预览、放大查看、复制图片）
- src/server.ts 服务端（SSE、会话与多图处理、持久化、日志）
- src/sessionStore.ts 文件会话存储（data/sessions/*.json）
- src/logger.ts 结构化日志（logs/server.log，JSONL）
- artifacts/ 生成与输入图片落盘位置（已忽略提交）
- data/sessions/ 会话持久化（已忽略提交）
- logs/ 运行日志（已忽略提交）

安全与隐私
- 不要在代码中硬编码 API Key；本项目只通过环境变量读取 GEMINI_API_KEY。
- .gitignore 已忽略 data/、logs/、artifacts/，避免将历史、日志、和图片产物提交到仓库。
- 如需公开演示，请确认 artifacts/ 中图片内容不含敏感信息。

已知说明
- 本项目用于本地开发/演示；生产部署请考虑鉴权、存储策略、并发与限流、异常重试等。
- 在中国大陆网络环境，访问 Google 服务可能需要合规网络环境支持。

许可
- 请选择并添加适合你的开源许可证（例如 MIT、Apache-2.0 等）。


