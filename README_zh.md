<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  NanoClaw —— 您的专属 AI 助手，在容器中安全运行。轻巧易懂，可根据需求灵活定制。
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

借助 Claude Code，NanoClaw 可以动态重写自身代码，根据您的需求定制功能。

**新功能：** 首个支持 [Agent Swarms（智能体集群）](https://code.claude.com/docs/en/agent-teams) 的 AI 助手。可组建智能体团队，在聊天中协作完成复杂任务。

## 为什么选择 NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) 有近 50 万行代码、53 个配置文件和 70+ 依赖项。其安全性是应用级别的（白名单、配对码），而非操作系统级隔离。

NanoClaw 用小到能理解的代码库提供同样的核心功能：一个进程，少数几个文件。智能体运行在具有文件系统隔离的真实 Linux 容器中。

## 快速开始

```bash
git clone https://github.com/lixuanxian/NanoClaw.git
cd NanoClaw
npm install
cd web && npm install && cd ..
npm run build:web
npm run dev
```

打开 `http://localhost:3030` 即可对话。在 设置 → AI 模型 中配置 AI 提供商。

**使用 Claude Code（可选）：** 运行 `claude`，然后 `/setup`，获得引导式安装。

## 设计哲学

- **小巧易懂。** 单一进程，少量源文件，无微服务。
- **通过隔离保障安全。** 智能体运行在 Linux 容器中（macOS 上为 Apple Container，或 Docker）。仅挂载目录可访问。
- **为个人用户打造。** Fork 本项目，让 Claude Code 根据您的需求修改。非框架，非臃肿软件。
- **定制即代码修改。** 无配置文件泛滥。想要不同行为？直接改代码。
- **AI 原生。** Claude Code 引导安装、调试和定制。没有它时，在设置中配置任意 AI 提供商即可。
- **技能优于功能。** 贡献者提交 [Claude Code 技能](https://code.claude.com/docs/en/skills) 来改造您的 fork，代码保持整洁。
- **最好的工具，最好的模型。** Claude 运行在 Claude Agent SDK 上。其他提供商使用各自原生 API。

## 功能支持

- **多 AI 提供商** — Claude、DeepSeek、MiniMax、QWEN、DOUBAO、OpenAI 兼容、Claude 兼容。在设置页面或环境变量配置
- **Web 聊天界面** — React + Ant Design SPA，支持深色/浅色主题、WebSocket 消息、会话持久化
- **多渠道同步** — Web（默认）、WhatsApp、Telegram、Discord、Slack、Signal、钉钉。共享文件夹的渠道同步到同一对话
- **容器隔离** — 智能体在 Apple Container (macOS) 或 Docker (macOS/Linux/Windows) 沙箱中运行
- **隔离的群组上下文** — 每个群组拥有独立的 `CLAUDE.md` 记忆、文件系统和容器沙箱
- **计划任务** — 运行智能体的周期性作业，可回发消息
- **网络访问** — 搜索和抓取网页内容
- **智能体集群** — 多个专业智能体团队协作完成复杂任务
- **A2A 协议** — 在 `/.well-known/agent-card.json` 发现 Agent Card
- **设置页面** — 在浏览器中配置 AI 提供商、渠道和集成
- **密码保护** — 可选的 `ADMIN_PASSWORD` 保护 Web 界面

## 使用方法

使用触发词（默认 `@Andy`）与助手对话：

```
@Andy 每周一到周五早上9点发一份销售渠道概览
@Andy 每周五回顾 git 历史，README 有出入就更新
@Andy 每周一早上8点，从 Hacker News 和 TechCrunch 收集 AI 资讯发给我
```

在主频道中管理群组和任务：
```
@Andy 列出所有群组的计划任务
@Andy 暂停周一简报任务
@Andy 加入"家庭聊天"群组
```

## 定制

告诉 Claude Code 您想要什么：

- "把触发词改成 @Bob"
- "回答要更简短直接"
- "说早上好时加一个自定义问候"

或运行 `/customize` 进行引导式修改。

## 贡献

**不要添加功能，添加技能。**

贡献技能文件 (`.claude/skills/<name>/SKILL.md`)，教 Claude Code 如何改造 NanoClaw。用户在自己的 fork 上运行技能，得到整洁的代码。

### RFS (技能征集)

- `/clear` — 压缩会话（总结上下文，保留关键信息）。需通过 Claude Agent SDK 实现编程式压缩。

## 系统要求

- macOS、Linux 或 Windows
- Node.js 20+
- [Apple Container](https://github.com/apple/container) (macOS) 或 [Docker](https://docker.com/products/docker-desktop) (macOS/Linux/Windows)
- AI 提供商 API key（设置页面配置），或 [Claude Code](https://claude.ai/download)（自动检测为默认）

## 架构

```
                    ┌─── Web 聊天
                    │
AI 智能体 ◄──► NanoClaw ──┼─── Slack
                    │
                    ├─── WhatsApp
                    │
                    └─── 钉钉 / ...
```

单一 Node.js 进程。渠道由配置驱动。共享文件夹的渠道同步到同一对话。智能体在隔离的 Linux 容器中执行。每文件夹消息队列带并发控制。通过文件系统 IPC 通信。

关键文件：`src/index.ts`（编排器）、`src/web-server.ts`（HTTP/WS）、`src/message-loop.ts`（轮询）、`src/container-runner.ts`（容器）、`src/router.ts`（路由）、`src/db.ts`（SQLite）、`web/`（React SPA）。

## FAQ

**为什么用 Docker？** 跨平台支持和成熟生态。macOS 上可通过 `/convert-to-apple-container` 切换到 Apple Container。

**可以在 Windows/Linux 上运行吗？** 可以。Docker Desktop（Windows 配合 WSL2）或 Docker（Linux）。运行 `/setup`。

**安全吗？** 智能体在容器中运行，具有文件系统隔离。仅明确挂载的目录可访问。详见 [docs/SECURITY.md](docs/SECURITY.md)。

**为什么没有配置文件？** 直接定制代码，代码库足够小，可以安全修改。

**如何调试？** 问 Claude Code，或运行 `/debug`。

**什么 PR 会被接受？** 仅安全修复、bug 修复和明确改进。其他应作为技能贡献。

## 社区

有疑问或建议？[加入 Discord 社区](https://discord.gg/VDdww8qS42)。

## 许可证

MIT
