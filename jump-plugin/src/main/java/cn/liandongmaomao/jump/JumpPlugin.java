package cn.liandongmaomao.jump;

import com.google.inject.Inject;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.connection.DisconnectEvent;
import com.velocitypowered.api.event.player.PlayerChooseInitialServerEvent;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.proxy.ProxyServer;
import com.velocitypowered.api.plugin.Plugin;
import com.velocitypowered.api.scheduler.ScheduledTask;
import org.slf4j.Logger;

import java.net.InetSocketAddress;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.TimeUnit;

@Plugin(id = "liandong-maomao-jump", name = "联动猫猫跳转", version = "0.1.0", description = "按域名路由、排队唤醒与代理心跳插件", authors = {"联动猫猫"})
public final class JumpPlugin {
    private final ProxyServer proxy;
    private final Logger logger;
    private final RouteResolver routes = new RouteResolver();
    private final QueueCoordinator queues = new QueueCoordinator(Duration.ofSeconds(5));
    private ManagerApiClient manager;
    private ScheduledTask heartbeatTask;

    @Inject
    public JumpPlugin(ProxyServer proxy, Logger logger) { this.proxy = proxy; this.logger = logger; }

    @Subscribe
    public void onProxyInitialization(ProxyInitializeEvent event) {
        String baseUrl = System.getenv().getOrDefault("JUMP_MANAGER_URL", "http://127.0.0.1:8080");
        String proxyId = System.getenv().getOrDefault("JUMP_PROXY_ID", "proxy-main");
        String token = System.getenv().getOrDefault("JUMP_MANAGER_TOKEN", "");
        manager = new ManagerApiClient(baseUrl, proxyId, token, Duration.ofSeconds(5));
        refreshConfig();
        heartbeatTask = proxy.getScheduler().buildTask(this, this::sendHeartbeat).repeat(15, TimeUnit.SECONDS).schedule();
        logger.info("联动猫猫跳转插件已启动，管理器: {}", baseUrl);
    }

    @Subscribe
    public void onChooseInitialServer(PlayerChooseInitialServerEvent event) {
        if (manager == null || event.getPlayer().getVirtualHost().isEmpty()) return;
        String hostname = ((InetSocketAddress) event.getPlayer().getVirtualHost().get()).getHostString();
        routes.resolve(hostname).ifPresent(route -> {
            String initialServer = route.ready() ? route.id() : route.entryProfile();
            proxy.getServer(initialServer).ifPresent(server -> {
                event.setInitialServer(server);
                if (!route.ready()) {
                    queues.enqueue(route.id(), event.getPlayer());
                    manager.wake(route.id(), event.getPlayer().getUniqueId().toString()).exceptionally(error -> {
                        logger.warn("唤醒目标 {} 失败: {}", route.id(), error.getMessage());
                        return null;
                    });
                }
            });
        });
    }

    @Subscribe
    public void onDisconnect(DisconnectEvent event) {
        // 队列条目由 UUID 绑定；真正的离线票据由管理器幂等接口承接，避免旧会话回调转移新会话。
    }

    private void refreshConfig() { manager.fetchConfig().thenAccept(routes::replace).exceptionally(error -> { logger.warn("刷新管理器配置失败: {}", error.getMessage()); return null; }); }
    private void sendHeartbeat() { if (manager == null) return; List<ManagerApiClient.HeartbeatTarget> observations = routes.targets().stream().map(target -> new ManagerApiClient.HeartbeatTarget(target.id(), proxy.getServer(target.id()).map(server -> server.getPlayersConnected().size()).orElse(0), "fresh")).toList(); manager.sendHeartbeat(observations).exceptionally(error -> { logger.warn("发送管理器心跳失败: {}", error.getMessage()); return null; }); }
    public void shutdown() { if (heartbeatTask != null) heartbeatTask.cancel(); }
}
