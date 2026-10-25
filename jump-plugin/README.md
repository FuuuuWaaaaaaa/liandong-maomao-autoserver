# 联动猫猫跳转插件

这是 Velocity 代理侧组件。它只保存管理器代理令牌，负责接收客户端原始域名、选择兼容入口、发送代理心跳，并把唤醒与队列状态交给 `server-manager`。

## 构建

需要 Java 21 与 Gradle：

```bash
./gradlew shadowJar
```

生成的插件位于 `build/libs/liandong-maomao-jump-plugin-0.1.0.jar`。生产环境通过 `JUMP_MANAGER_URL`、`JUMP_PROXY_ID`、`JUMP_MANAGER_TOKEN` 注入管理器地址与代理凭证，不要把真实凭证写进仓库。

## 运行边界

- 不访问 Pterodactyl，不连接 MySQL，也不包含面板密钥。
- 所有网络请求均为异步 HTTP。
- 目标服务器的启动、就绪确认、停止策略由管理器控制。
- 入口档案必须针对实际 Forge、NeoForge、Fabric 或 Paper 客户端实测。
