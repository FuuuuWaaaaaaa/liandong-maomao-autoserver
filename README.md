# 联动猫猫· 联动启停

这是一个面向 Minecraft 多后端网络的按需开服项目：玩家通过 Velocity 代理输入目标域名，控制面按需唤醒 Pterodactyl 服务器，等待真实游戏就绪后串行转移玩家，并用代理心跳在安全条件下自动优雅关服。

仓库由两个隔离应用组成：

- `server-manager/`：TypeScript + React 控制面，负责 Pterodactyl 生命周期、MySQL 持久化、代理心跳、在线队列与离线等待票据，以及中文液态玻璃 WebUI。
- `jump-plugin/`：Java 21 + Velocity 插件，负责原始主机名路由、入口档案选择、代理心跳和玩家侧队列衔接。Pterodactyl 凭证永远不进入插件。

## 当前实现

管理器已经提供 `/api/v1` 代理合约：配置拉取、心跳、幂等唤醒、生命周期查询、票据创建/事件和双队列摘要；提供 `health/live`、`health/ready` 健康检查；默认生产存储是 MySQL，内存模式必须显式设置 `STORAGE_MODE=memory`，只用于本地测试。WebUI 支持浅色与深色主题、服务器状态表和异常提示。

插件提供可编译的 Velocity 接入骨架：异步管理器客户端、精确域名路由、入口服务器选择、按目标队列和定时心跳。真正上线前仍需用实际 modpack 完成入口档案兼容性测试，并接入完整的转移确认与离线票据 UI 流程。

## 本地启动管理器

```bash
cd server-manager
npm install
cp .env.example .env
# 本地无 MySQL 时仅为测试显式使用：STORAGE_MODE=memory
STORAGE_MODE=memory PROXY_TOKENS='proxy-main=dev-proxy-token' ADMIN_API_TOKEN=dev-admin-token npm run dev
```

本地管理器建议使用 Node.js 22 或更高版本。

打开 `http://127.0.0.1:8080/` 可查看控制台。WebUI 读取浏览器 `localStorage.admin-token` 作为管理员 Token；正式部署应改为完整的会话登录流程并启用 TLS。

## GitHub Docker 镜像

每次推送 `main` 或发布 `v*` 标签时，GitHub Actions 会自动构建并发布管理器镜像到 GitHub Container Registry：

```bash
docker pull ghcr.io/fuuuuwaaaaaaa/liandong-maomao-server:latest
```

首次发布后，如果 GitHub 将 Container package 保持为私有，需要在仓库的 **Packages** 页面把 `liandong-maomao-server` 改为 Public，之后即可匿名拉取。镜像只包含管理器，不包含 MySQL；生产数据库仍然使用你的独立 MySQL 服务。

## Docker 与变量

推荐使用 Compose 拉取镜像并执行一次数据库迁移：

```bash
cd server-manager
cp .env.example .env
# 编辑 .env 后执行
docker compose pull
docker compose run --rm mysql-migration
docker compose up -d manager
```

也可以直接运行镜像：

```bash
docker run --rm --name liandong-maomao-server \
  -p 8080:8080 \
  -e SQL_TYPE=mysql \
  -e SQL_ADDRESS='mysql://用户:密码@数据库地址:3306/数据库名' \
  -e ADMIN_API_TOKEN='替换为随机管理员令牌' \
  -e PTERODACTYL_URL='https://panel.example.net' \
  -e PTERODACTYL_API_TOKEN='替换为面板 Client API Token' \
  ghcr.io/fuuuuwaaaaaaa/liandong-maomao-server:latest
```

管理器变量如下：

| 变量 | 必填 | 说明 |
|---|---:|---|
| `SQL_TYPE` | 是 | SQL 类型。生产使用 `mysql`；`memory` 仅用于本地演示，不持久化数据。 |
| `SQL_ADDRESS` | `mysql` 时必填 | MySQL DSN，例如 `mysql://manager:密码@mysql.example.net:3306/minecraft_manager`。 |
| `HOST` | 否 | 监听地址，默认 `0.0.0.0`。 |
| `PORT` | 否 | HTTP 端口，默认 `8080`。 |
| `ADMIN_API_TOKEN` | 建议 | 管理控制台 API 令牌。 |
| `PROXY_TOKENS` | 代理接入时必填 | 代理令牌映射，格式 `proxy-main=随机令牌,proxy-2=随机令牌`。 |
| `PTERODACTYL_URL` | 使用面板时必填 | Pterodactyl 面板地址。 |
| `PTERODACTYL_API_TOKEN` | 使用面板时必填 | Pterodactyl Client API Token，只放在管理器环境变量或 Docker Secret。 |
| `PTERODACTYL_TIMEOUT_MS` | 否 | 面板请求超时，默认 `5000`。 |
| `HEARTBEAT_FRESHNESS_SECONDS` | 否 | 代理心跳新鲜窗口，默认 `45`。 |

旧部署可以继续使用 `STORAGE_MODE` 和 `DATABASE_URL`，但新配置优先使用 `SQL_TYPE` 和 `SQL_ADDRESS`。

## 插件构建

```bash
cd jump-plugin
./gradlew shadowJar
```

需要 Java 21。代理侧通过环境变量注入 `JUMP_MANAGER_URL`、`JUMP_PROXY_ID`、`JUMP_MANAGER_TOKEN`。请为每个代理使用独立的随机令牌，并限制后台服务器端口只允许代理访问。

## 重要安全边界

- Pterodactyl Client API Token 只存在于管理器运行时秘密中，不出现在插件配置、浏览器响应或日志。
- 自动停止只允许 graceful `stop`；心跳过期、面板状态未知、队列有需求或存在转移时会暂停关服。
- 在线队列与离线等待名单分开统计；离线玩家重新连接时通过 UUID 幂等恢复票据。
- `running` 不等于 Minecraft 已就绪；管理器必须完成游戏层就绪探测后才能派发队列。

详细行为约束见 [`ARCHITECTURE.md`](ARCHITECTURE.md)、[`jump-plugin/PROJECT_SPEC.md`](jump-plugin/PROJECT_SPEC.md) 和 [`server-manager/PROJECT_SPEC.md`](server-manager/PROJECT_SPEC.md)。
