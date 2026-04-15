# CLIProxy Sub2 Panel

一个面向 `CLIProxyAPI` 的轻量账号面板，提供公开只读看板、管理员模式、额度查询、Usage 仪表盘、模型价格配置与缓存快照能力。

项目由一个 Node.js 单文件后端和一个纯静态前端组成，适合以 `docker compose` 方式快速部署。

## 功能概览

- 静态托管前端页面
- 从上游 `CLIProxyAPI` 拉取账号列表与 usage 数据
- 本地缓存账号列表快照、usage 快照、quota 快照
- 页面首屏优先读取本地缓存，减少闪屏
- 顶部账号统计、搜索、组别筛选、排序、分页
- Usage 仪表盘
- 模型价格配置与成本估算
- 管理员模式
- 公开只读模式
- 管理员敏感操作二次校验：`session cookie + 管理员 key`

## 适用场景

- 给自己或团队提供一个更直观的 `CLIProxyAPI` 账号看板
- 在只读模式下公开监控数据，但不暴露危险写操作
- 对 Codex / OpenAI 类 auth 文件做启停管理、额度探测和 usage 聚合分析

## 项目结构

```text
.
├── docker-compose.yml
├── server.js
├── site/
│   └── index.html
├── data/
│   ├── admin-auth.json
│   ├── panel-config.json
│   ├── usage-cache.json
│   ├── quota-cache.json
│   └── dashboard-cache.json
└── refs/
    └── management.html
```

## 工作方式

### 后端职责

- 托管前端静态资源
- 保存面板配置
- 代理访问上游 `CLIProxyAPI`
- 定时轮询 `/v0/management/usage`
- 读取本地 auth 文件元信息
- 从上游配置中读取第一个 `api-key` 用于请求 `/v1/models`
- 为前端提供公开只读接口和管理员敏感接口

### 前端职责

- 展示账号列表、状态、最近使用时间、窗口统计
- 读取 `dashboard-cache` 作为首屏快照
- 在管理员模式下执行手动刷新、额度刷新、启停等敏感操作
- 在只读模式下仅提供浏览、筛选、搜索、排序、分页能力

## 缓存文件说明

项目会在 `data/` 下维护以下文件：

- `panel-config.json`
  - 保存上游 `CLIProxyAPI` 地址与管理密钥
- `admin-auth.json`
  - 保存管理员密码
- `usage-cache.json`
  - 保存共享 usage 缓存
- `quota-cache.json`
  - 保存 quota 探测结果缓存
- `dashboard-cache.json`
  - 保存前端首屏快照缓存

## 安全模型

### 公开只读模式

默认进入公开只读模式。

公开只读模式下：

- 可以查看账号列表与缓存数据
- 可以搜索、筛选、排序、分页
- 不允许执行刷新、额度探测、启停、配置变更等敏感操作

### 管理员模式

管理员模式通过页面顶部按钮进入。

当前实现为两层校验：

1. 先通过管理员密码登录，获得 `session cookie`
2. 敏感请求还必须附带管理员 key 请求头：`X-Panel-Admin-Key`

也就是说，敏感操作必须同时满足：

- 已登录管理员会话
- 请求头中带有正确的管理员 key

当前前端会在管理员登录成功后，自动把管理员 key 附到敏感请求上。

## 接口说明

### 公开只读接口

- `GET /api/public/config`
- `GET /api/public/auth-files`
- `GET /api/public/usage-cache`

### 前端缓存读取接口

以下接口用于前端读取本地快照缓存：

- `GET /api/quota-cache`
- `GET /api/dashboard-cache`

### 敏感接口

以下接口需要管理员会话和 `X-Panel-Admin-Key`：

- `GET/POST /api/public/refresh-usage-cache`
- `GET /api/public/quota?name=...`
- `GET /api/model-list`
- `PUT /api/panel-config`
- `POST /api/auth-toggle`
- `PUT /api/quota-cache`
- `PUT /api/dashboard-cache`
- `/api/management/*`

### 管理员会话接口

- `GET /api/admin/status`
- `POST /api/admin/login`
- `POST /api/admin/logout`

## 部署方式

当前仓库自带的部署方式是 `docker compose`。

### 依赖条件

- Docker
- Docker Compose
- 一个可访问的 `CLIProxyAPI` 上游服务
- 上游服务使用的 `config.yaml`
- 上游服务的 `auths` 目录

### 当前 compose 的挂载假设

当前 `docker-compose.yml` 假设：

- 本项目目录与 `cli-proxy-api-cn` 目录平级
- 上游配置文件路径为 `../cli-proxy-api-cn/config.yaml`
- 上游 auth 目录路径为 `../cli-proxy-api-cn/auths`

如果你的目录结构不同，请自行调整挂载路径。

### docker-compose.yml

项目当前使用如下方式运行：

```yaml
services:
  cliproxy-sub2-panel:
    image: node:20-alpine
    container_name: cliproxy-sub2-panel
    restart: unless-stopped
    working_dir: /app
    command: ["node", "/app/server.js"]
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "8320:80"
    volumes:
      - ./site:/app/site:ro
      - ./server.js:/app/server.js:ro
      - ./data:/data
      - ../cli-proxy-api-cn/config.yaml:/config/cli-proxy-api.yaml:ro
      - ../cli-proxy-api-cn/auths:/auths
```

### 启动步骤

1. 克隆仓库

```bash
git clone <your-repo-url>
cd cliproxy-sub2-panel
```

2. 准备数据目录

```bash
mkdir -p data
```

3. 准备管理员认证文件

建议手动创建 `data/admin-auth.json`：

```json
{
  "password": "please-change-this-password"
}
```

说明：

- 不要在公开环境中使用弱密码
- 不要把真实密码提交到 GitHub

4. 准备面板配置文件

创建 `data/panel-config.json`：

```json
{
  "baseUrl": "http://your-cliproxy-host:8317",
  "managementKey": "your-management-key"
}
```

5. 按需修改 `docker-compose.yml` 中的端口和挂载路径

6. 启动服务

```bash
docker compose up -d
```

7. 打开页面

```text
http://<your-host>:8320
```

## 本地开发

如果你不想用 Docker，也可以直接在宿主机运行：

```bash
node server.js
```

可用环境变量：

- `PORT`
- `SITE_ROOT`
- `DATA_DIR`
- `CLIPROXY_CONFIG_FILE`
- `HOST_BRIDGE`
- `AUTH_DIR`
- `USAGE_POLL_INTERVAL_MS`

示例：

```bash
PORT=8320 DATA_DIR=./data SITE_ROOT=./site AUTH_DIR=../cli-proxy-api-cn/auths node server.js
```

## 管理员模式使用说明

### 登录

页面顶部点击 `管理员模式`，输入管理员密码即可登录。

### 管理员 key

登录后，前端会把当前输入的管理员密码作为管理员 key，用于附加到敏感请求头：

```text
X-Panel-Admin-Key: <admin-password>
```

### curl 示例

先登录：

```bash
curl -c cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"password":"<ADMIN_PASSWORD>"}' \
  http://127.0.0.1:8320/api/admin/login
```

再调用敏感接口：

```bash
curl -b cookies.txt \
  -H 'X-Panel-Admin-Key: <ADMIN_PASSWORD>' \
  http://127.0.0.1:8320/api/public/refresh-usage-cache
```

## 刷新与缓存机制

### 后端轮询

- 后端每 `15s` 轮询一次上游 `/v0/management/usage`
- 结果写入 `data/usage-cache.json`

### 页面首屏

- 页面优先读取 `dashboard-cache.json`
- 然后再决定是否执行后台刷新

### 管理员刷新

管理员模式下：

- `刷新` = 刷新账号列表 + 刷新 usage + 刷新额度
- `暂停` 可以中止当前刷新链路
- 自动刷新也会执行同样的刷新链路

### 游客可见性

游客不能主动执行敏感刷新，但能看到管理员刷新后已经写入缓存的数据。

## 前端行为说明

### 顶部统计

- 顶部显示账号总数与各状态统计
- 统计数字受搜索条件影响
- 统计数字不受组选中影响
- 普通点击状态按钮：切换到单组
- `Ctrl/Cmd` 点击：多选组别

### 仪表盘

- 支持折叠
- 可展示请求、Token、成本、趋势、健康状态、模型统计等区块
- 当没有选中任何显示组别时，顶部和仪表盘显示 `N/A`

### 额度显示

- 优先显示真实 quota 窗口
- quota 未取到时回退为代理统计
- 刷新 quota 时保留旧额度条，并在标题旁显示 `（刷新中）`
- 刷新成功后直接替换为新额度结果
- 刷新失败时回退并显示失败提示

### 成本计算

按模型价格配置计算成本，当前公式为：

```text
(input - cached) * prompt
+ output * completion
+ cached * cached_price
```

未配置价格的模型会被忽略。

## GitHub 发布前必看

这个项目当前是一个本地运维面板，直接上传到 GitHub 前请先处理敏感文件。

### 不要提交这些文件

- `data/panel-config.json`
- `data/admin-auth.json`
- `data/usage-cache.json`
- `data/quota-cache.json`
- `data/dashboard-cache.json`

这些文件里可能包含：

- 管理密钥
- 管理员密码
- 账号元信息
- 使用统计数据

### 推荐添加 `.gitignore`

建议至少忽略：

```gitignore
data/*.json
!data/.gitkeep
```

### 不要把现网地址和密钥写死在 README

如果你准备开源：

- 用占位符替换真实 IP、端口、密码和密钥
- 检查历史提交里是否已经提交过敏感数据
- 如已提交，先清理 Git 历史再公开

## 常见问题

### 1. 页面能打开，但数据为空

优先检查：

- `data/panel-config.json` 是否正确
- 上游 `CLIProxyAPI` 是否可访问
- `managementKey` 是否有效
- `auths` 目录是否成功挂载到容器内 `/auths`

### 2. 游客为什么看不到实时刷新

因为只读模式下不允许触发敏感刷新与 quota 探测。

游客能看到的是：

- 后端轮询写入的共享 `usage-cache`
- 管理员刷新后落盘的缓存快照

### 3. 管理员已经登录，为什么敏感操作仍然 403

因为当前实现要求两层校验：

- 登录 cookie
- `X-Panel-Admin-Key`

如果你是自己写脚本调用接口，不仅要先登录，还要把管理员 key 一起带上。

## 后续可改进方向

- 仪表盘增加“全部账号 / 跟随筛选”切换
- 服务健康监测视觉继续优化
- 管理员权限再细分
- 增加 `.gitignore`、LICENSE、发布说明和截图

## 许可

本项目使用 `MIT` 许可证。

详见仓库根目录下的 `LICENSE` 文件。
