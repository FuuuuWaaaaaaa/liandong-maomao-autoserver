# 联动猫猫跳转插件

这是 Velocity 代理侧组件。它只保存管理器代理令牌，负责接收客户端原始域名、选择兼容入口、发送代理心跳，并把唤醒与队列状态交给 `server-manager`。

## 配置文件

插件首次启动时会在 Velocity 数据目录生成 `plugins/liandong-maomao-jump/config.yml`。可以直接编辑该文件，不需要把配置写入启动命令：

```yaml
manager:
  base-url: "https://manager.example.net"
  proxy-id: "proxy-main"
  token: "${JUMP_MANAGER_TOKEN}"
  request-timeout-ms: 5000
  config-refresh-seconds: 30
  heartbeat-seconds: 15
queue:
  transfer-notice-seconds: 5
  transfer-stability-seconds: 2
messages:
  locale: "zh_CN"
```

`manager.token` 支持 `${环境变量名}` 占位符。推荐使用 `${JUMP_MANAGER_TOKEN}`，然后在 Velocity 进程环境中设置令牌；也可以直接填写令牌，但不应将包含真实令牌的配置文件提交到 Git。`manager.proxy-id` 必须与 WebUI 创建的代理 ID 或管理器 `PROXY_TOKENS` 中的 ID 一致。`base-url`、`proxy-id` 和时间参数均从该文件读取，修改后重启代理生效。

使用 MySQL 管理器时，也可以在 WebUI 的“设置 → 代理接入”中输入代理名称并生成凭证。复制页面显示的一次性 `config.yml` 片段即可，不需要手工生成 `proxy-id` 或随机令牌；重新生成令牌后必须替换配置并重启 Velocity。

插件收到目标配置后会按域名选择目标；目标未就绪时把玩家送入 `entry-profile` 指定的等待服务器，异步请求管理器唤醒目标。管理器确认 Minecraft 状态可用后，插件逐个发送 5 秒提示并连接玩家，成功连接后等待稳定窗口再处理下一位。在线票据和离线票据都会通过管理器幂等保存。

活动票据保留时间由管理器的 `TICKET_TTL_SECONDS` 设置；在线排队玩家会随插件心跳续期，离线玩家重新连接时会刷新原票据。

管理员可以在 Velocity 控制台执行：

```text
/jump status <目标ID>
/jump queue <目标ID>
/jump test <目标ID>
/jump route <玩家连接域名>
/jump refresh
```

这些命令需要 `jump.admin` 权限，不会显示代理令牌或面板凭证。`queue` 会同时读取在线队列和离线等待票据；`test` 会显示管理器读取到的生命周期、就绪状态和玩家数。插件心跳会携带插件版本和 API 版本；无法确认后端注册状态时发送 `unknown` 质量，管理器不会把它误判为空服。

## 构建

需要 Java 21 与 Gradle：

```bash
./gradlew shadowJar
```

生成的插件位于 `build/libs/liandong-maomao-jump-plugin-0.1.0.jar`。生产环境只需要通过 `JUMP_MANAGER_TOKEN` 注入配置文件中的代理令牌占位符，不要把真实凭证写进仓库。

## 运行边界

- 不访问 Pterodactyl，不连接 MySQL，也不包含面板密钥。
- 所有网络请求均为异步 HTTP。
- 目标服务器的启动、就绪确认、停止策略由管理器控制。
- 入口档案必须针对实际 Forge、NeoForge、Fabric 或 Paper 客户端实测。
