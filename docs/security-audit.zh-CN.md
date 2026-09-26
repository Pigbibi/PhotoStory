# 安全设计与部署检查

PhotoStory 处理私人照片、OAuth 连接和可选发布权限。以下内容是部署者应保留的
安全设计与检查清单，不是某次审计的历史结论。

## 身份与浏览器边界

- 所有私有接口和图片响应都在服务端验证会话；公开页面不是授权边界。
- GitHub 用户名允许名单每次请求都会重新检查。登录不请求仓库权限，也不保存
  GitHub access token。
- 会话使用随机、`HttpOnly`、`Secure`、`SameSite=Lax` cookie；变更请求要求同源。
- OAuth 使用一次性 state、PKCE 和限流 binding。不要删除 `AUTH_LIMITER`。

## 凭据与服务边界

- Microsoft token 以 Worker Secret 中的密钥加密后才写入 D1。
- `BATCH_TOKEN` 只属于 Worker 与受信任 VPS；不能交给浏览器、模型、插件或公开
  工作流。泄露时同时轮换两端。
- AI 子进程只能收到允许名单中的环境变量，不能收到 Graph token、机器 token 或
  Instagram 凭据。环境过滤不替代独立 Linux 用户、文件权限和 systemd 隔离。
- 密钥、数据库导出、`.env` 文件、OAuth 回调 URL 和发布临时链接都不能提交到仓库。

## 照片与存储边界

- OneDrive 原图只读，不由 PhotoStory 删除。审核预览会去除 EXIF。
- Worker 限定下载域名、拒绝异常端口和重定向，不会把 Graph bearer token 转发给
  图片下载主机。
- D1 和可选 R2 均为私有存储。R2 不应启用公共域名、`r2.dev` 或公开桶策略。
- 发布 JPEG 只在已开始发布流程且状态有效的短期内提供；拿到链接的人在有效期内可以
  读取，因此不要分享链接。

## AI 与发布边界

- 图片、文件名、元数据和模型输出都是不可信数据，不能执行其中的指令。
- AI 可能漏判。人工审核是默认路径；严格 AI 审核只是额外条件，不是隐私保证。
- 偏好记录只影响安全候选的排序，不能批准、发布或降低地点和隐私要求。
- 发布状态机不重放结果不明的外部请求。遇到不明结果，先在 Instagram 和私有记录中
  核对，再决定下一步。

## 部署检查清单

1. 使用自己的 Cloudflare 账号、D1、OAuth 应用和机器凭据；公开模板只作起点。
2. 将 `wrangler.local.jsonc`、VPS 环境文件、状态目录和备份排除在 Git 之外，并限制
   文件权限。
3. 在部署前运行 `npm test`、Python unittest 与 `npm run build`。
4. 在真实照片前，用最小范围检查 AI 账户、VPS 隔离、OneDrive 授权和手动发布。
5. 生产错误只记录安全的阶段和状态码；不要为排障打开请求体、令牌或照片日志。

安全设置并不能替代部署者对账号、保留期限、AI 服务数据政策和 Instagram 规则的判断。
