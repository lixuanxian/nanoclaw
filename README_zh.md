<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  NanoClaw —— 您的专属 AI 助手，在容器中安全运行。它轻巧易懂，并能根据您的个人需求灵活定制。
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

借助 Claude Code，NanoClaw 可以动态重写自身代码，根据您的需求定制功能。

**新功能：** 首个支持 [Agent Swarms（智能体集群）](https://code.claude.com/docs/en/agent-teams) 的 AI 助手。可轻松组建智能体团队，在您的聊天中高效协作。

## 我为什么创建这个项目

[OpenClaw](https://github.com/openclaw/openclaw) 是一个令人印象深刻的项目，但我无法安心使用一个我不了解却能访问我个人隐私的软件。OpenClaw 有近 50 万行代码、53 个配置文件和 70 多个依赖项。其安全性是应用级别的（通过白名单、配对码实现），而非操作系统级别的隔离。所有东西都在一个共享内存的 Node 进程中运行。

NanoClaw 用一个小到您能理解的代码库，为您提供了同样的核心功能：一个进程，少数几个文件。Claude 智能体运行在具有文件系统隔离的真实 Linux 容器中，而不是依赖于权限检查。

## 快速开始

```bash
git clone https://github.com/lixuanxian/NanoClaw.git
cd NanoClaw
npm install
cd web && npm install && cd ..
npm run build:web
npm run dev
```

打开 `http://localhost:3030` 即可与您的助手对话。在 设置 → AI 模型 中配置您的 AI 提供商。

**使用 Claude Code（可选）：** 运行 `claude`，然后 `/setup`，获得引导式安装，包括 WhatsApp、计划任务和后台服务配置。

## 设计哲学

**小巧易懂。** 单一进程，少量源文件，无微服务。如果您想了解完整的 NanoClaw 代码库，只需让 Claude Code 为您讲解。

**通过隔离保障安全。** 智能体运行在 Linux 容器（macOS 上的 Apple Container 或 Docker）中，它们只能看到被明确挂载的内容。Bash 访问是安全的，因为命令在容器内执行，不会直接操作您的宿主机。

**为个人用户打造。** NanoClaw 不是一个庞大的框架，而是为每位用户量身定制的软件。NanoClaw 不会变成臃肿软件，而是设计为个性化的。您只需 Fork 本项目，然后让 Claude Code 根据您的需求进行修改。

**定制即代码修改。** 没有配置文件泛滥。想要不同的行为？直接修改代码。代码库足够小，这样做是安全的。

**AI 原生。** 当 Claude Code 可用时，它会引导安装、调试和定制。没有 Claude Code 时，在设置页面配置您偏好的 AI 提供商即可立即开始。

**技能优于功能。** 贡献者不向代码库添加功能（例如支持 Telegram），而是提交像 `/add-telegram` 这样的 [Claude Code 技能](https://code.claude.com/docs/en/skills) 来改造您的 fork。最终，您得到的是只做您需要事情的整洁代码。

**最好的工具套件，最好的模型。** 使用 Claude 作为 AI 提供商时，NanoClaw 运行在 Claude Agent SDK 之上，提供最强大的能力。其他提供商使用各自的原生 API，同样获得完整支持。

## 功能支持

- **多 AI 提供商** - Claude、DeepSeek、MiniMax、QWEN、DOUBAO、OpenAI 兼容端点和 Claude 兼容端点。在设置页面或通过环境变量配置。本地安装 Claude CLI 时默认使用 Claude；否则配置任意提供商即可开始使用
- **Web 聊天界面** - 基于 React + Ant Design 的 SPA，在 `http://localhost:3030` 通过浏览器聊天，支持深色/浅色主题、WebSocket 实时消息和会话持久化
- **密码保护** - 可选的 `ADMIN_PASSWORD` 环境变量，用于保护 Web 界面
- **设置页面** - 在浏览器中配置各渠道（WhatsApp、Slack、钉钉）
- **多渠道** - Web 聊天（默认）、WhatsApp、Telegram、Discord、Slack、Signal 以及无头模式
- **隔离的群组上下文** - 每个群组都拥有独立的 `CLAUDE.md` 记忆、隔离的文件系统，并在各自的容器沙箱中运行
- **主频道** - 您的私有频道（self-chat），用于管理控制；其他所有群组都完全隔离
- **计划任务** - 运行 Claude 的周期性作业，并可以给您回发消息
- **网络访问** - 搜索和抓取网页内容
- **容器隔离** - 智能体在 Apple Container (macOS) 或 Docker (macOS/Linux/Windows) 的沙箱中运行
- **智能体集群** - 启动多个专业智能体团队，协作完成复杂任务
- **A2A 协议** - 在 `/.well-known/agent-card.json` 发现 Agent Card
- **可选集成** - 通过技能添加 Gmail (`/add-gmail`) 等更多功能

## 使用方法

使用触发词（默认为 `@Andy`）与您的助手对话：

```
@Andy 每周一到周五早上9点，给我发一份销售渠道的概览（需要访问我的 Obsidian vault 文件夹）
@Andy 每周五回顾过去一周的 git 历史，如果与 README 有出入，就更新它
@Andy 每周一早上8点，从 Hacker News 和 TechCrunch 收集关于 AI 发展的资讯，然后发给我一份简报
```

在主频道（您的 self-chat）中，可以管理群组和任务：
```
@Andy 列出所有群组的计划任务
@Andy 暂停周一简报任务
@Andy 加入"家庭聊天"群组
```

## 定制

NanoClaw 不使用配置文件。要做更改，直接告诉 Claude Code 您想要什么：

- "把触发词改成 @Bob"
- "记住以后回答要更简短直接"
- "当我说早上好的时候，加一个自定义的问候"
- "每周存储一次对话摘要"

或者运行 `/customize` 进行引导式修改。

代码库足够小，Claude 可以安全地修改它。

## 贡献

**不要添加功能，而是添加技能。**

如果您想添加 Telegram 支持，不要创建一个把 Telegram 和 WhatsApp 放在一起的 PR。而是贡献一个技能文件 (`.claude/skills/add-telegram/SKILL.md`)，教 Claude Code 如何改造一个 NanoClaw 安装以使用 Telegram。

然后用户在自己的 fork 上运行 `/add-telegram`，就能得到只做他们需要事情的整洁代码，而不是一个试图支持所有用例的臃肿系统。

### RFS (技能征集)

我们希望看到的技能：

**会话管理**
- `/clear` - 添加一个 `/clear` 命令，用于压缩会话（在同一会话中总结上下文，同时保留关键信息）。需要研究如何通过 Claude Agent SDK 以编程方式触发压缩。

## 系统要求

- macOS、Linux 或 Windows
- Node.js 20+
- [Apple Container](https://github.com/apple/container) (macOS) 或 [Docker](https://docker.com/products/docker-desktop) (macOS/Linux/Windows)
- AI 提供商 API key（在设置页面配置），或 [Claude Code](https://claude.ai/download)（自动检测为默认）

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

单一 Node.js 进程。渠道由配置驱动（`CHANNELS=web,whatsapp,slack`）。共享同一文件夹的所有渠道会同步到同一对话 — AI 智能体能看到所有渠道的消息并向所有渠道广播响应。智能体在具有文件系统隔离的 Linux 容器中执行，仅挂载目录可被访问。每个群组的消息队列带有并发控制。通过文件系统进行 IPC 通信。

关键文件：
- `src/index.ts` - 编排器：状态管理、消息循环、智能体调用
- `src/web-server.ts` - Hono HTTP 服务器、WebSocket、认证、静态 SPA 服务
- `web/` - React + Ant Design SPA（聊天、设置、登录）
- `src/channels/web.ts` - Web 渠道（通过 WebSocket 的浏览器聊天）
- `src/channels/whatsapp.ts` - WhatsApp 渠道（Baileys）
- `src/ipc.ts` - IPC 监听与任务处理
- `src/router.ts` - 消息格式化与出站路由
- `src/group-queue.ts` - 带全局并发限制的群组队列
- `src/container-runner.ts` - 生成流式智能体容器
- `src/task-scheduler.ts` - 运行计划任务
- `src/db.ts` - SQLite 操作（消息、群组、会话、状态）
- `groups/*/CLAUDE.md` - 各群组的记忆

## FAQ

**为什么用 Docker？**

Docker 提供跨平台支持（macOS、Linux，甚至通过 Docker Desktop 支持 Windows）和成熟的生态系统。在 macOS 上，您可以选择通过运行 `/convert-to-apple-container` 切换到 Apple Container，以获得更轻量级的原生运行时体验。

**可以在 Windows 上运行吗？**

可以。Docker Desktop 配合 WSL2 后端在 Windows 上可用。只需运行 `/setup`。

**可以在 Linux 上运行吗？**

可以。Docker 是默认的容器运行时，在 macOS 和 Linux 上都可用。只需运行 `/setup`。

**这个项目安全吗？**

智能体在容器中运行，而不是在应用级别的权限检查之后。它们只能访问被明确挂载的目录。您仍然应该审查您运行的代码，但这个代码库小到您真的可以做到。完整的安全模型请见 [docs/SECURITY.md](docs/SECURITY.md)。

**为什么没有配置文件？**

我们不希望配置泛滥。每个用户都应该定制 NanoClaw，让代码完全符合他们的需求，而不是去配置一个通用的系统。如果您喜欢用配置文件，告诉 Claude 让它加上。

**如何调试问题？**

问 Claude Code。"为什么计划任务没有运行？" "最近的日志里有什么？" "为什么这条消息没有得到回应？" 这就是 NanoClaw 所采用的 AI 原生方法。

**为什么安装不成功？**

如果遇到问题，安装过程中 Claude 会尝试动态修复。如果仍不行，运行 `claude`，然后运行 `/debug`。如果 Claude 发现一个可能影响其他用户的问题，请开一个 PR 来修改安装 SKILL.md。

**什么样的代码更改会被接受？**

仅接受安全修复、bug 修复以及对基础配置的明确改进。

其他一切（新功能、操作系统兼容性、硬件支持、增强功能）都应该作为技能来贡献。

这使得基础系统保持最小化，并让每个用户可以定制他们的安装，而无需继承他们不想要的功能。

## 社区

有任何疑问或建议？欢迎[加入 Discord 社区](https://discord.gg/VDdww8qS42)与我们交流。

## 许可证

MIT
