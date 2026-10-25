# 联动猫猫·联动启停控制面

联动猫猫·联动启停控制面是一套面向 Minecraft 多后端网络的服务器生命周期管理系统。系统通过 Velocity 代理接收玩家的目标域名，在目标服务器离线时调用 Pterodactyl Client API 执行唤醒，完成 Minecraft 游戏层就绪探测后按序转移玩家，并依据代理心跳在满足安全条件时执行优雅关服。

项目采用控制面与代理插件分离的架构。Pterodactyl 凭证、MySQL 连接信息和管理权限只保留在管理器服务中；Velocity 插件仅持有独立的代理访问令牌。

仓库由两个隔离应用组成：

- `server-manager/`：TypeScript + React 控制面，负责 Pterodactyl 生命周期、MySQL 持久化、代理心跳、在线队列与离线等待票据，以及中文液态玻璃 WebUI。
- `jump-plugin/`：Java 21 + Velocity 插件，负责原始主机名路由、入口档案选择、代理心跳和玩家侧队列衔接。Pterodactyl 凭证永远不进入插件。

## 系统组成

- `server-manager/`：TypeScript API、React WebUI、MySQL 迁移、Pterodactyl 客户端和 Docker 镜像。
- `jump-plugin/`：Java 21 + Velocity 插件，负责域名路由、入口档案、代理心跳和玩家侧队列衔接。
- `.github/workflows/docker-publish.yml`：自动构建并发布管理器 GHCR 镜像。
- `.github/workflows/plugin-release.yml`：按 `plugin-v*` 标签构建并发布 Velocity 插件 Release 附件。

管理器提供 `/api/v1` 代理合约、健康检查、双队列票据和生命周期状态模型。插件提供异步管理器客户端、精确域名路由、入口服务器选择、按目标队列和定时心跳。正式上线前仍需针对实际 modpack 完成入口档案兼容性测试。

## 本地启动管理器

```bash
cd server-manager
npm install
cp .env.example .env
# 本地无 MySQL 时仅为测试显式使用 memory
SQL_TYPE=memory PROXY_TOKENS='proxy-main=dev-proxy-token' ADMIN_API_TOKEN=dev-admin-token npm run dev
```

本地管理器建议使用 Node.js 22 或更高版本。

打开 `http://127.0.0.1:8080/` 可查看控制台。

### 浏览器管理员令牌验证

管理器当前使用一个由环境变量 `ADMIN_API_TOKEN` 设置的管理员 API 令牌进行控制台访问控制。它不是 Pterodactyl Token，也不是 Velocity 代理令牌。浏览器输入框只负责验证这个已在服务端设置的值，不会替你创建或修改服务端令牌。

1. 启动管理器前设置 `ADMIN_API_TOKEN`，建议使用长度至少 32 位的随机值。例如 Docker Compose 的 `.env` 中写入 `ADMIN_API_TOKEN=一串随机值`，直接运行镜像时使用 `-e ADMIN_API_TOKEN='一串随机值'`。
2. 如果修改了 `.env` 或 Docker 环境变量，必须重启管理器容器/进程；服务启动后不会动态读取新的环境变量。
3. 打开与管理器同一个地址的 WebUI。首次访问总览页会显示“需要管理员会话”。
4. 在提示框中输入与服务端环境变量完全一致的 `ADMIN_API_TOKEN`，点击“保存并验证”；也可以进入“设置 → 管理员令牌”完成相同操作。
5. 验证成功后，浏览器才会将令牌保存在当前浏览器的本地存储中，后续请求通过 `Authorization: Bearer <令牌>` 发送到管理器。
6. 更换令牌后，在“设置”中重新验证；需要清除本机凭证时点击“清除浏览器令牌”。

如果页面提示“管理器未配置 ADMIN_API_TOKEN”，说明服务端没有读到该变量，需要检查 Compose 的 `env_file`、Docker `-e` 参数或进程启动命令，并重启服务。如果提示“管理员令牌无效”，说明浏览器输入值与当前运行进程读到的值不一致；请重新核对变量值和访问的端口/域名。不要把变量名 `ADMIN_API_TOKEN` 本身当作令牌输入。

令牌不会写入项目文件，也不会发送给 Pterodactyl。生产环境必须通过 HTTPS 访问 WebUI，并避免在公共电脑上保存管理员令牌。

三类令牌的用途不同：

| 令牌 | 使用方 | 配置位置 | 用途 |
|---|---|---|---|
| `ADMIN_API_TOKEN` | 管理员浏览器 | 管理器环境变量 | 访问 WebUI 的管理接口。 |
| `PROXY_TOKENS` 中的值 | Velocity 插件 | 管理器环境变量；插件 `config.yml` 通过 `${JUMP_MANAGER_TOKEN}` 引用 | 代理读取配置、发送心跳和请求唤醒。 |
| `PTERODACTYL_API_TOKEN` | 管理器服务 | 管理器环境变量或 Docker Secret | 调用 Pterodactyl Client API；绝不能写入插件。 |

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

旧部署可以继续使用 `STORAGE_MODE` 和 `DATABASE_URL`，但新配置优先使用 `SQL_TYPE` 和 `SQL_ADDRESS`。`SQL_TYPE=mysql` 时，迁移命令必须先成功执行；应用启动不会在每个副本中重复运行迁移。

## 插件构建

```bash
cd jump-plugin
./gradlew shadowJar
```

需要 Java 21。插件首次启动会在 Velocity 数据目录生成 `config.yml`，管理器地址、代理 ID、请求超时和心跳周期均在该文件中配置；令牌可通过 `${JUMP_MANAGER_TOKEN}` 环境变量占位符注入。请为每个代理使用独立的随机令牌，并限制后台服务器端口只允许代理访问。

## 发布 Velocity 插件版本

向 `main` 推送 `plugin-v` 前缀的标签会自动构建测试，并创建 GitHub Release，上传可直接放入 Velocity `plugins/` 目录的 JAR 文件：

```bash
git tag plugin-v0.1.0
git push origin plugin-v0.1.0
```

发布完成后，在 GitHub 仓库的 **Releases** 页面下载 `liandong-maomao-jump-plugin-0.1.0.jar`。也可以在 GitHub Actions 中手动运行“发布 Velocity 插件”工作流，并填写版本号。插件构建使用 Java 21，发布前会执行单元测试和 `shadowJar` 打包。

## 重要安全边界

- Pterodactyl Client API Token 只存在于管理器运行时秘密中，不出现在插件配置、浏览器响应或日志。
- 自动停止只允许 graceful `stop`；心跳过期、面板状态未知、队列有需求或存在转移时会暂停关服。
- 在线队列与离线等待名单分开统计；离线玩家重新连接时通过 UUID 幂等恢复票据。
- `running` 不等于 Minecraft 已就绪；管理器必须完成游戏层就绪探测后才能派发队列。

详细行为约束见 [`ARCHITECTURE.md`](ARCHITECTURE.md)、[`jump-plugin/PROJECT_SPEC.md`](jump-plugin/PROJECT_SPEC.md) 和 [`server-manager/PROJECT_SPEC.md`](server-manager/PROJECT_SPEC.md)。
