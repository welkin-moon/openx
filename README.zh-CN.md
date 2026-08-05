# OpenX

**简体中文** | [English](README.md)

OpenX 是一个仅以 AGPL-3.0 发布、由用户持有身份与内容的社交网络基础设施。它围绕可迁移的签名事件、加密内容对象、Git 仓库与 Cloudflare Workers 构建。

项目当前定义三个 Web 角色：

- **用户节点**：接收已经签名的密文事件与媒体，直接写入用户自己的 Git 仓库，并在之后向广播器发布轻量元数据。
- **广播器**：分发对象指针，维护 Tag、可信互动、认证和价值观标签等索引；不保存帖子正文、评论正文、媒体或解密密钥。
- **强圈子**：维护投稿、收录、审核与签名治理决定；原始内容始终留在作者节点。

未来的 Web、PWA 或原生客户端通过稳定 Manifest 和协议接口发现这些角色。

## 已确定的设计

### Git 仓库就是耐久写前日志

普通发帖不需要 GitHub Discussions、D1、Queue 或单独的消息缓冲层。

- 普通帖子或互动立即写成一个不可变签名事件对象。
- 客户端或 MCP 代理可以把多条已经签名的事件组成一个 NDJSON 批次，以减少 Git API 调用。
- 写入失败由客户端保留并重试。
- 定时任务只负责把不可变 inbox 对象压缩成更大的 journal 包，并向广播器批量公告；归档不位于发帖成功路径上。

### 广播器保持轻量

广播器保存指针和判断，不保存用户内容。它可以发布：

- 对象公告；
- Tag 边；
- 回复、点赞、关注等关系边；
- 可信互动视图；
- 身份证明、认证和价值观标签；
- 撤回或失效记录。

### 存储平台可以替换

OpenX 身份和对象 ID 使用 DID 与哈希，不使用 GitHub URL 作为身份。`GitProvider` 当前实现 GitHub，之后计划支持 GitLab、Forgejo/Gitea/Codeberg 和通用 Git 兼容存储。

### 普通用户不需要 Fork 源码

目标安装器只在首次部署一个很小的 Supervisor。后续 OpenX 版本从官方签名 Release 取得，并通过 Cloudflare 部署 API 自动安装。用户自己的 Git 仓库只存数据，不需要维护或同步 OpenX 源码 Fork。

## 仓库结构

```text
apps/
  node-worker/       用户节点
  relay-worker/      轻量发现与信任广播器
  circle-worker/     有治理的强圈子索引
packages/
  protocol/          规范化签名事件格式
  git-provider/      可替换 Git 存储适配器
  worker-kit/        Worker HTTP 通用工具
docs/
tests/
```

## 当前 HTTP 接口

用户节点：

```text
GET  /openx/v1/manifest
POST /openx/v1/events
POST /openx/v1/events/batch
PUT  /openx/v1/media/{sha256}
```

服务端只接受密文与公开元数据。加密、签名和失败重试状态属于客户端或 MCP 侧。

## 当前状态

目前是可执行的架构骨架，还不是生产版本。尚未完成的主要部分包括：

- 一次性 Cloudflare Supervisor/初始化流程；
- 用户数据仓库的 GitHub OAuth、GitHub App 或 fine-grained token 配置；
- Pages Direct Upload 与官方签名版本自动更新；
- Git journal 定时压缩和广播器批量投递；
- 加密媒体 Manifest 与媒体仓库自动轮换；
- 设备授权、恢复和受众密钥轮换；
- 强圈子多签治理；
- 完整 Web/PWA 客户端与协议一致性测试向量。

## 开发

```bash
npm test
npm run check
```

## 文档

- [架构说明](docs/architecture.md)
- [初始化、凭据与更新](docs/bootstrap-and-updates.md)

## 许可证

GNU Affero General Public License v3.0 only（`AGPL-3.0-only`）。
