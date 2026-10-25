# AGENTS.md

## 项目是什么

开源自建的照片整理台，服务一个固定的私人照片流程。从 OneDrive 读有限范围的照片，把合适的风景照变成可编辑草稿，保留人工复核。

## 技术栈

React / Vite 前端，Cloudflare Worker 提供 API，Python 照片处理脚本的依赖见 `scripts/requirements.txt`。

## 目录

- `src/` — 前端与服务。
- `worker/` — Cloudflare API。
- `scripts/` — 照片处理与发布工具。
- `runtime/` — 运行时。
- `deploy/` — systemd 部署。
- `docs/` — 英文为默认，中文加 `.zh-CN.md` 后缀。
- `tests/` — 测试。

## 本地验证

按改动选择相关离线检查，命令以仓库当前 CI 为准。先区分代码问题与环境条件，不为通过检查降低保护。

**依赖**

```bash
npm ci
```

**测试**

```bash
npm test
```

**构建**

```bash
npm run build
```

## 命名与文档

- 新增文档文件名小写、`-` 连接，中文版后缀 `.zh-CN.md`；`README.md`、`AGENTS.md` 等工具约定文件保留固定名称。源码沿用现有语言命名。
- 不提交审计报告、复盘、交接单、进度快照、升级计划。要追溯看 commit 历史。
- 改文件名时同一次提交改完所有引用。
- 提交前跑 `python scripts/check_hygiene.py`。

## 不要做

- 不要扩大 OneDrive 读取范围。设计前提是有限范围，越界会拖慢整条流程。
- 不要跳过人工复核直接发布。草稿需要人确认。
- 不要在日志或错误信息里输出照片内容、文件路径或账号信息。

## 提交与 PR

Conventional Commits，标题中文，不超过 50 字。类型只用 `feat` `fix` `docs` `refactor` `test` `chore` `perf` `ci`。

分支名 `<type>/<主题>`，例如 `docs/normalize-filenames`。不直接推默认分支，不 force push 已 review 的分支。

提交、推送、合并及生产动作按用户已明确授权的范围执行；同范围已有授权不重复确认。

PR 描述写改了什么、为什么改、怎么验证。
