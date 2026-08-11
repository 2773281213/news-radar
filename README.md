# 新闻雷达（News Radar）

面向 7×24 小时新闻工作的聚合、去重、事件聚类、多源核验与简报 Agent。系统保留原始链接和时间戳，把“已确认”“存在争议”“尚待核实”分开呈现，避免把单一来源直接改写成事实结论。

线上地址：<https://news.11451405.xyz>

## 主要能力

- RSS、JSON Feed、GDELT、Bluesky、Mastodon、Telegram Web 等来源适配
- URL 归一化、SimHash/文本相似度去重、事件聚类与时间线
- 说法抽取、独立来源覆盖度计算和多方核验状态
- 可审计的三省工作流：中书拟稿、门下封驳/准奏、尚书下令与成报
- 六部真实并行办理：来源身份、经济、外交社会、冲突安全、法律核查、科技灾害均生成独立具报
- ArchiveAssistant 思路的主从阅读工作区：宽屏三栏、中屏双栏、移动端案簿/奏折/批红单窗切换
- 中枢总览、六部工作台、实时事件、事件审议记录、搜索、简报与来源健康度
- 可选 Anthropic、OpenAI 兼容接口或 Ollama；未配置模型时自动使用抽取式降级
- Telegram、邮件和 Web Push 提醒通道
- SSRF 防护、请求限流、安全响应头、管理接口令牌

## 本地运行

要求 Node.js 20 或更高版本。

```bash
npm ci
cp .env.example .env
npm run dev
```

默认 API 监听 `127.0.0.1:8787`，Vite 开发服务器会启动前端。首次运行会在 `DATA_DIR` 中创建 SQLite 数据库并载入内置来源。

常用命令：

```bash
npm run check       # TypeScript 类型检查
npm test            # 单元与 API 测试
npm run build       # 构建前端和服务端
npm start           # 启动生产构建
npm run check:sources
```

## 配置

复制 `.env.example` 后按需修改。生产环境至少应设置：

- `ADMIN_TOKEN`：保护管理接口的随机长令牌
- `PUBLIC_BASE_URL`：公开访问地址
- `DATA_DIR`：SQLite 数据和备份目录
- `AI_PROVIDER`：`none`、`anthropic`、`openai` 或 `ollama`

AI 与提醒通道都是可选项。未配置 AI 密钥不会阻止采集、聚类、搜索和抽取式简报运行。

## 数据处理链路

```text
来源采集
  → 内容清洗与 URL 归一化
  → 去重入库
  → 事件聚类与时间线
  → 说法抽取和多源核验
  → 中书省形成证据提案与六部分派
  → 门下省检查独立性、来源身份和覆盖缺口
  → 尚书省下达执行令
  → 六部并行形成带 Claim 与 Citation 的专责报告
  → 尚书省汇总六部具报
  → 刷新摘要、评估提醒并成报
```

三省六部是可解释的新闻筛选和发布状态机，不是装饰性分类：

- **中书省**汇总事件、主张、来源家族和覆盖缺口，形成确定性提案。
- **门下省**执行对抗复核；“封驳”只表示当前证据不足，不表示事件为假。
- **尚书省**只执行门下准奏的提案；先下达六部工作单，再汇总报告并调用现有摘要与提醒服务。
- **六部**允许一个事件主送一部、会同多部。六部各自产出发现、风险、补证缺口、执行建议及逐篇引用；未获分派的部门以 `blocked` 留痕，不冒充已办理。
- **成报门槛**要求六份工作单全部进入终态：获分派部门必须 `completed`，未分派部门必须 `blocked`，随后摘要与提醒也必须完成；任何失败都不会标记为可发布。
- AI 只参与通过引用校验的文字生成，不拥有批准、驳回或分派权限。

同一证据指纹和规则版本只会产生一次逻辑运行；状态迁移保存在追加式审计日志中。每个重试 attempt 都有独立工作单和写入栅栏，过期任务不能覆盖后续运行。核验状态表示当前证据覆盖情况，不是对现实世界真假的永久裁决。新增来源或材料后，事件会重新进入审议。

## 工作区与发布缓存

首页采用案簿、奏折队列、审议详情三栏主从结构；中等宽度收为双栏，窄屏通过“案簿 / 奏折 / 批红”标签一次只显示一个窗格。审议详情直接读取事件工作流 API，展示中书奏议、门下朱批、尚书执行令、六部具报及追加式时间线，不用新闻卡片冒充部门报告。

Service Worker 对页面导航采用 network-first，并以 `cache: no-store` 获取当前 HTML，断网时才回退离线页；带哈希的静态资源继续 cache-first。构建会为已知的旧 Service Worker 壳生成入口兼容别名；发布脚本还会从全部可信历史 release 中继承 Vite 哈希 `.js/.css` 普通文件，且不覆盖新构建同名文件。两层兼容使尚未完成 Service Worker 更新的旧页面首次打开时也不会因资源已删除而白屏。

## 生产部署

`deploy/install.sh` 面向当前 Ubuntu + Nginx + systemd 环境，使用不可变 release 目录和 `current` 符号链接：

```bash
npm run build
npm run release:pack
# 将生成的 .tgz 与同名 .tgz.sha256 一并上传后执行：
sudo bash deploy/install.sh /tmp/news-radar-release-<版本>-<release-id>.tgz <release-id>
```

部署脚本会：

1. 校验 SHA-256、release ID、归档路径、完整迁移链和必需文件，再安装生产依赖；
2. 在激活新 release 前安全继承历史哈希静态资源，拒绝链接、非哈希文件和覆盖写入；
3. 创建权限为 `0600` 的 `/etc/news-radar.env`；
4. 安装并校验 Nginx 配置；
5. 先启动只承载 API/UI 的 `news-radar.service`，健康后再启动低优先级的 `news-radar-scheduler.service`；
6. 在失败时统一恢复上一 release、systemd unit 和 Nginx 配置；
7. 通过证书监视器签发并切换独立 HTTPS 证书。

生产运维：

```bash
systemctl status news-radar.service
journalctl -u news-radar-scheduler.service -n 100 --no-pager
systemctl status news-radar-scheduler.service
journalctl -u news-radar.service -n 100 --no-pager
curl -fsS https://news.11451405.xyz/api/health
nginx -t
```

Web 与采集/审议调度使用独立进程并共享 WAL 模式 SQLite。这样来源抓取、文本聚类和三省六部审议即使遇到重负载，也不会占住对外 HTTP 事件循环；调度进程以较低 CPU/IO 优先级运行，并通过带过期时间的数据库心跳向健康接口报告状态。

敏感配置保存在 `/etc/news-radar.env`，不要提交到版本库或复制到前端代码。

## 目录

```text
src/app/                 React 前端（中枢、六部、事件、简报与审议视图）
src/server/adapters/     新闻来源适配器
src/server/pipeline/     去重、聚类、核验、三省治理、六部专责报告、简报与搜索
src/server/routes/       公共与管理 API
src/server/services/     采集、调度、工作流持久化、存储和提醒服务
src/server/db/           SQLite/Drizzle 数据层
deploy/                  Nginx、systemd、证书与部署脚本
```
