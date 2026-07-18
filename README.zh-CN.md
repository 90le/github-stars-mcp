# GitHub Stars MCP

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/90le/github-stars-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/90le/github-stars-mcp/actions/workflows/ci.yml)
[![CodeQL](https://github.com/90le/github-stars-mcp/actions/workflows/codeql.yml/badge.svg)](https://github.com/90le/github-stars-mcp/actions/workflows/codeql.yml)
[![Node.js 22 and 24](https://img.shields.io/badge/node-22%20%7C%2024-339933)](https://nodejs.org/)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

一个面向 AI 的 MCP Server。它通过 GitHub 官方 API，帮助 Codex、Claude、Cursor 等 AI 安全地发现、整理和维护 GitHub Star 仓库与 User Lists。

项目在本地 SQLite 中保存快照和审计记录，提供有边界的 MCP 工具面。它面向 AI Agent，不是浏览器自动化工具，也不是给人逐条操作的交互式 CLI。

## 能做什么

- 同步完整、可审计的 Star 和 User Lists 快照。
- 按 Star 数、语言、许可证、更新时间、归档状态、Fork 状态等条件筛选仓库。
- 搜索和发现新仓库，将候选持久化到本地，并可直接送入可审核计划，但不会自动收藏搜索结果。
- 创建、修改、删除 GitHub User List，并维护其中的仓库成员关系。
- 通过明确的、哈希绑定的变更计划 Star 或取消 Star 仓库。
- 记录执行、尝试、失败、远程回读和可补偿的回滚计划。

## 10 个 MCP 工具

| 工具                             | 用途                             | 是否修改 GitHub |
| -------------------------------- | -------------------------------- | --------------- |
| `github_stars_status`            | 身份、权限、状态和 API 限额      | 否              |
| `github_stars_sync`              | 同步完整 Star/List 快照          | 否              |
| `github_stars_query`             | 筛选、排序、聚合和分页查询 Star  | 否              |
| `github_lists_query`             | 查询分类/List 和成员关系         | 否              |
| `github_repositories_discover`   | 搜索有限范围的候选仓库和证据     | 否              |
| `github_repositories_candidates` | 查询已持久化的发现候选仓库       | 否              |
| `github_changes_plan`            | 把请求解析成不可变变更计划       | 否              |
| `github_changes_inspect`         | 查看计划、执行、尝试和回读结果   | 否              |
| `github_changes_apply`           | 执行已检查并获授权的计划         | 是              |
| `github_changes_rollback`        | 从部分或完整执行结果生成补偿计划 | 否              |

## 安全执行流程

所有修改都必须经过：

```text
发现 → 候选查询 → 创建计划 → 检查计划 → 授权 → 执行 → 审计
```

服务默认是只读模式。每个写入计划都有稳定的 ID 和 SHA-256 哈希，并包含受保护的仓库/List、过期时间、前置条件、操作数量上限、依赖顺序和可恢复的审计记录。如果某次写入结果不明确，系统会先回读 GitHub 状态，再决定是否继续，绝不会盲目重试。

只有 `github_changes_apply` 可以调用 GitHub 修改接口。Token 只保存在内存中，会从错误信息中脱敏，并且不会写入 SQLite 或日志。

## 安装

GitHub Stars MCP 支持 Windows、macOS 和 Linux 上的 Node.js 22、24。1.x 版本支持 GitHub.com。

使用 GitHub CLI 登录：

```bash
gh auth login --hostname github.com
gh auth status --hostname github.com
```

检查本地运行环境和 GitHub 权限：

```bash
npx -y github-stars-mcp@1.0.0 --doctor
```

在 MCP Host 中配置：

```json
{
  "mcpServers": {
    "github-stars-mcp": {
      "command": "npx",
      "args": ["-y", "github-stars-mcp@1.0.0", "--stdio"],
      "env": {
        "GITHUB_STARS_MCP_AUTH_MODE": "auto",
        "GITHUB_STARS_MCP_READ_ONLY": "true",
        "GITHUB_STARS_MCP_LOG_LEVEL": "warning"
      }
    }
  }
}
```

AI 在同步、查询、创建计划和检查计划期间应保持 `GITHUB_STARS_MCP_READ_ONLY=true`。只有在已经检查过具体计划并获得授权后，才应在对应 MCP 进程中设置为 `false`。

凭据读取顺序为：`GITHUB_STARS_TOKEN`、`GITHUB_TOKEN`、`GH_TOKEN`，最后是 `gh auth token --hostname github.com`。建议使用只授予 Star 和 User Lists 所需权限的专用凭据。

`github_stars_status` 会返回身份、能力、快照、执行、数据库和限额信息，但不会返回进程的 `GITHUB_STARS_MCP_READ_ONLY` 设置；请在 MCP Host 配置中确认该值。

查询使用稳定的公开字段，例如 `name_with_owner`、`stargazers_count`、`language`、`license`、`archived`、`disabled` 和 `fork`。

## AI 使用示例

对于“找出 Star 少于 1 万、三年没有更新的仓库，保护指定仓库，生成可审核的清理计划”这类任务，AI 应该：

1. 调用 `github_stars_sync`。
2. 使用 `github_stars_query` 按条件筛选并获取有限证据。
3. 使用 `github_changes_plan` 并传入受保护的仓库 ID。
4. 使用 `github_changes_inspect` 检查计划，并展示准确的计划哈希。
5. 只有得到明确授权后，调用 `github_changes_apply`。
6. 再次检查执行结果，必要时生成回滚计划。

搜索发现会把候选保存到本地，但不会自动收藏仓库。AI 可以调用 `github_repositories_candidates`，使用稳定仓库 ID 创建计划，再经过“检查 → 授权 → 执行”流程后才会成为 Star。

公开变更协议使用 `operations`、稳定仓库 ID 和准确的计划哈希：

```text
github_changes_plan
  snapshot_id: "snap_demo_20260718"
  operations:
    - kind: "unstar"
      repositories:
        repository_ids: ["R_demo_obsolete"]
  protected_repository_ids: ["R_demo_keep"]

github_changes_inspect
  kind: "plan"
  id: "plan_demo_cleanup"

github_changes_apply
  plan_id: "plan_demo_cleanup"
  expected_hash: "<plan_hash>"
```

`github_changes_inspect` 支持 `plan`、`run`、`attempts` 和 `reconciliations` 四种分支。必须把检查结果中的完整 `plan_hash` 原样传入 `expected_hash`，不能自行编造或截短。

## 能力边界

本项目可以管理当前登录用户的 Star 和 User Lists，但不能删除、归档、转移、重命名、修改可见性或修改代码仓库内容，也不提供通用 REST、GraphQL、浏览器、Shell、仓库管理或组织管理能力。

## 文档

- [架构设计](docs/architecture.md)
- [MCP 工具参考](docs/tool-reference.md)
- [安全模型](docs/security.md)
- [Codex 插件](docs/plugin.md)
- [开发与发布](docs/development.md)
- [需求与验证矩阵](docs/requirements.md)
- [故障排查](docs/troubleshooting.md)

## 许可证

Apache-2.0，详见 [LICENSE](LICENSE)。
