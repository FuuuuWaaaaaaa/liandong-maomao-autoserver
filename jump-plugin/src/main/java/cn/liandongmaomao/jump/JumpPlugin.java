package cn.liandongmaomao.jump;

import com.google.inject.Inject;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.connection.DisconnectEvent;
import com.velocitypowered.api.event.player.PlayerChooseInitialServerEvent;
import com.velocitypowered.api.event.player.ServerConnectedEvent;
import com.velocitypowered.api.event.proxy.ProxyShutdownEvent;
import com.velocitypowered.api.command.SimpleCommand;
import com.velocitypowered.api.command.SimpleCommand.Invocation;
import com.velocitypowered.api.plugin.Plugin;
import com.velocitypowered.api.plugin.annotation.DataDirectory;
import com.velocitypowered.api.proxy.Player;
import com.velocitypowered.api.proxy.ProxyServer;
import com.velocitypowered.api.proxy.server.RegisteredServer;
import com.velocitypowered.api.scheduler.ScheduledTask;
import net.kyori.adventure.text.Component;
import org.slf4j.Logger;

import java.net.InetSocketAddress;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

@Plugin(id = "liandong-maomao-jump", name = "联动猫猫跳转", version = PluginVersion.VALUE, description = "按域名路由、排队唤醒与代理心跳插件", authors = {"联动猫猫"})
public final class JumpPlugin {
    private record TransferLease(UUID playerId, UUID sessionToken) {}

    private final ProxyServer proxy;
    private final Logger logger;
    private final Path dataDirectory;
    private final RouteResolver routes = new RouteResolver();
    private final QueueCoordinator queues = new QueueCoordinator(Duration.ofSeconds(5));
    private final Map<UUID, String> targetByPlayer = new ConcurrentHashMap<>();
    private final Map<UUID, String> ticketByPlayer = new ConcurrentHashMap<>();
    private final Map<UUID, CompletableFuture<ManagerApiClient.Ticket>> ticketWrites = new ConcurrentHashMap<>();
    private final Map<String, TransferLease> transferByTarget = new ConcurrentHashMap<>();
    private final Map<UUID, Boolean> connectedTargetPlayers = new ConcurrentHashMap<>();
    private final Map<UUID, Player> sessionPlayers = new ConcurrentHashMap<>();
    private final Map<UUID, UUID> sessionTokens = new ConcurrentHashMap<>();
    private final Map<UUID, Integer> transferFailures = new ConcurrentHashMap<>();
    private ManagerApiClient manager;
    private ScheduledTask heartbeatTask;
    private ScheduledTask configTask;
    private long noticeSeconds = 5;
    private long stabilitySeconds = 2;

    @Inject
    public JumpPlugin(ProxyServer proxy, Logger logger, @DataDirectory Path dataDirectory) {
        this.proxy = proxy;
        this.logger = logger;
        this.dataDirectory = dataDirectory;
    }

    @Subscribe
    public void onProxyInitialization(com.velocitypowered.api.event.proxy.ProxyInitializeEvent event) {
        PluginConfig.Values config;
        try {
            config = PluginConfig.load(dataDirectory, logger);
        } catch (Exception error) {
            logger.error("读取插件 config.yml 失败，插件不会启动管理器连接", error);
            return;
        }
        manager = new ManagerApiClient(config.managerUrl(), config.proxyId(), config.token(), config.requestTimeout());
        noticeSeconds = config.transferNoticeSeconds();
        stabilitySeconds = config.transferStabilitySeconds();
        refreshConfig();
        heartbeatTask = proxy.getScheduler().buildTask(this, this::sendHeartbeat).repeat(config.heartbeatSeconds(), TimeUnit.SECONDS).schedule();
        configTask = proxy.getScheduler().buildTask(this, this::refreshConfig).repeat(config.configRefreshSeconds(), TimeUnit.SECONDS).schedule();
        proxy.getCommandManager().register("jump", new JumpCommand());
        logger.info("联动猫猫跳转插件已启动，管理器: {}，配置文件: {}", config.managerUrl(), dataDirectory.resolve("config.yml"));
    }

    @Subscribe
    public void onChooseInitialServer(PlayerChooseInitialServerEvent event) {
        if (manager == null || event.getPlayer().getVirtualHost().isEmpty()) return;
        String hostname = ((InetSocketAddress) event.getPlayer().getVirtualHost().get()).getHostString();
        Optional<ManagerApiClient.TargetRoute> resolved = routes.resolve(hostname);
        if (resolved.isEmpty()) return;
        ManagerApiClient.TargetRoute route = resolved.get();
        UUID playerId = event.getPlayer().getUniqueId();
        sessionPlayers.put(playerId, event.getPlayer());
        UUID sessionToken = UUID.randomUUID();
        sessionTokens.put(playerId, sessionToken);
        targetByPlayer.put(playerId, route.id());
        String initialServer = route.ready() ? route.id() : route.entryProfile();
        Optional<RegisteredServer> server = initialServer == null || initialServer.isBlank() ? Optional.empty() : proxy.getServer(initialServer);
        if (server.isEmpty()) {
            if (route.ready()) {
                event.getPlayer().disconnect(Component.text("目标服务器暂时无法进入：Velocity 中未注册目标后端。请联系管理员。"));
            } else {
                saveOfflineTicket(event.getPlayer(), route.id(), sessionToken, "等待入口不可用")
                        .whenComplete((ticket, error) -> {
                            if (!isCurrentSession(event.getPlayer(), playerId, sessionToken)) return;
                            String suffix = error == null ? "离线等待票据已保存。" : "无法保存等待票据，请联系管理员。";
                            event.getPlayer().disconnect(Component.text("目标服务器暂时无法进入：等待入口未配置或不存在。" + suffix));
                        });
            }
            return;
        }
        event.setInitialServer(server.get());
        if (route.ready()) promoteExistingTicket(event.getPlayer(), route.id(), sessionToken);
        if (!route.ready()) {
            queues.enqueue(route.id(), event.getPlayer());
            saveOnlineTicket(event.getPlayer(), route.id());
            manager.wake(route.id(), sessionToken.toString()).whenComplete((result, error) -> {
                if (error == null) return;
                logger.warn("唤醒目标 {} 失败: {}", route.id(), error.getMessage());
                if (isCurrentSession(event.getPlayer(), playerId, sessionToken)) event.getPlayer().sendMessage(Component.text("目标暂时无法启动，请稍后重试或联系管理员。"));
            });
        }
    }

    @Subscribe
    public void onServerConnected(ServerConnectedEvent event) {
        Player player = event.getPlayer();
        String targetId = targetByPlayer.get(player.getUniqueId());
        if (targetId == null || !event.getServer().getServerInfo().getName().equals(targetId)) return;
        TransferLease lease = transferByTarget.get(targetId);
        if (lease != null && lease.playerId().equals(player.getUniqueId()) && lease.sessionToken().equals(sessionTokens.get(player.getUniqueId()))) return;
        connectedTargetPlayers.put(player.getUniqueId(), Boolean.TRUE);
        // The transfer workflow waits for the stability window before releasing the target lock.
    }

    @Subscribe
    public void onDisconnect(DisconnectEvent event) {
        Player player = event.getPlayer();
        UUID playerId = player.getUniqueId();
        if (!sessionPlayers.remove(playerId, player)) return;
        UUID sessionToken = sessionTokens.remove(playerId);
        String targetId = targetByPlayer.remove(playerId);
        boolean wasConnected = connectedTargetPlayers.remove(playerId) != null;
        ticketByPlayer.remove(playerId);
        if (targetId != null) {
            queues.remove(targetId, playerId);
            releaseTransfer(targetId, playerId, sessionToken);
            dispatchTarget(targetId);
        }
        transferFailures.remove(playerId);
        if (targetId == null || wasConnected) return;
        CompletableFuture<ManagerApiClient.Ticket> pendingWrite = ticketWrites.remove(playerId);
        CompletableFuture<Void> priorWrite = pendingWrite == null ? CompletableFuture.completedFuture(null) : pendingWrite.handle((ignored, error) -> null);
        priorWrite.thenCompose(ignored -> saveOfflineTicket(player, targetId, sessionToken, "玩家连接中断，重新连接后继续等待"))
                .exceptionally(error -> { logger.warn("保存玩家 {} 的离线票据失败: {}", playerId, error.getMessage()); return null; });
    }

    private void refreshConfig() {
        if (manager == null) return;
        manager.fetchConfig().thenAccept(config -> {
            routes.replace(config);
            sendHeartbeat();
            for (ManagerApiClient.TargetRoute route : routes.targets()) {
                if (route.ready()) {
                    dispatchTarget(route.id());
                } else if (route.lifecycle().equals("OFFLINE") && queues.size(route.id()) > 0) {
                    manager.wake(route.id(), UUID.randomUUID().toString()).exceptionally(error -> {
                        logger.warn("排队需求触发目标 {} 唤醒失败: {}", route.id(), error.getMessage());
                        return null;
                    });
                }
            }
        }).exceptionally(error -> {
            logger.warn("刷新管理器配置失败: {}", error.getMessage());
            return null;
        });
    }

    private void dispatchTarget(String targetId) {
        if (transferByTarget.containsKey(targetId)) return;
        ManagerApiClient.TargetRoute route = routes.findById(targetId).orElse(null);
        if (route == null || !route.ready()) return;
        UUID playerId;
        Optional<Player> player;
        UUID sessionToken;
        while (true) {
            playerId = queues.poll(targetId);
            if (playerId == null) return;
            player = proxy.getPlayer(playerId);
            sessionToken = sessionTokens.get(playerId);
            if (player.isPresent() && sessionToken != null && sessionPlayers.get(playerId) == player.get()) break;
        }
        TransferLease lease = new TransferLease(playerId, sessionToken);
        if (transferByTarget.putIfAbsent(targetId, lease) != null) {
            queues.enqueue(targetId, playerId);
            return;
        }
        Player queuedPlayer = player.get();
        UUID queuedPlayerId = playerId;
        UUID queuedSessionToken = sessionToken;
        Component notice = Component.text("目标服务器已就绪，将在 " + noticeSeconds + " 秒后为你连接。");
        queuedPlayer.sendMessage(notice);
        queuedPlayer.sendActionBar(notice);
        proxy.getScheduler().buildTask(this, () -> transfer(targetId, queuedPlayer, queuedPlayerId, queuedSessionToken)).delay(noticeSeconds, TimeUnit.SECONDS).schedule();
    }

    private void releaseTransfer(String targetId, UUID playerId, UUID sessionToken) {
        if (sessionToken == null) return;
        transferByTarget.computeIfPresent(targetId, (ignored, lease) -> lease.playerId().equals(playerId) && lease.sessionToken().equals(sessionToken) ? null : lease);
    }

    private boolean isCurrentSession(Player player, UUID playerId, UUID sessionToken) {
        return sessionToken != null && sessionToken.equals(sessionTokens.get(playerId)) && sessionPlayers.get(playerId) == player
                && proxy.getPlayer(playerId).map(current -> current == player).orElse(false);
    }

    private void transfer(String targetId, Player player, UUID playerId, UUID sessionToken) {
        if (!isCurrentSession(player, playerId, sessionToken)) {
            releaseTransfer(targetId, playerId, sessionToken);
            dispatchTarget(targetId);
            return;
        }
        ManagerApiClient.TargetRoute route = routes.findById(targetId).orElse(null);
        RegisteredServer target = proxy.getServer(targetId).orElse(null);
        if (route == null || !route.ready() || target == null) {
            failTransfer(targetId, player, playerId, sessionToken, "目标状态已变化，请稍后重试");
            return;
        }
        player.createConnectionRequest(target).connect().whenComplete((result, error) -> {
            if (!isCurrentSession(player, playerId, sessionToken)) {
                releaseTransfer(targetId, playerId, sessionToken);
                dispatchTarget(targetId);
                return;
            }
            if (error != null || result == null || !result.isSuccessful()) {
                failTransfer(targetId, player, playerId, sessionToken, "连接目标服务器失败，请稍后重试");
                return;
            }
            proxy.getScheduler().buildTask(this, () -> {
                if (!isCurrentSession(player, playerId, sessionToken)) {
                    releaseTransfer(targetId, playerId, sessionToken);
                    dispatchTarget(targetId);
                    return;
                }
                if (proxy.getPlayer(playerId).flatMap(Player::getCurrentServer).map(server -> server.getServerInfo().getName().equals(targetId)).orElse(false)) {
                    completeTransfer(targetId, playerId, sessionToken);
                } else {
                    failTransfer(targetId, player, playerId, sessionToken, "目标服务器未确认连接，请稍后重试");
                }
            }).delay(stabilitySeconds, TimeUnit.SECONDS).schedule();
        });
    }

    private void completeTransfer(String targetId, UUID playerId, UUID sessionToken) {
        if (!sessionToken.equals(sessionTokens.get(playerId))) return;
        transferFailures.remove(playerId);
        connectedTargetPlayers.put(playerId, Boolean.TRUE);
        String ticketId = ticketByPlayer.get(playerId);
        CompletableFuture<ManagerApiClient.Ticket> pendingWrite = ticketWrites.remove(playerId);
        CompletableFuture<ManagerApiClient.Ticket> priorWrite = pendingWrite == null ? CompletableFuture.completedFuture(null) : pendingWrite.handle((ticket, error) -> ticket);
        priorWrite.thenCompose(ticket -> {
                    String actualTicketId = ticketId != null ? ticketId : ticket == null ? null : ticket.id();
                    if (actualTicketId == null) return CompletableFuture.completedFuture(null);
                    return reportTicketEvent(targetId, actualTicketId, "transferred", "已连接目标服务器")
                            .whenComplete((ignored, error) -> { if (error == null) ticketByPlayer.remove(playerId, actualTicketId); });
                });
        releaseTransfer(targetId, playerId, sessionToken);
        dispatchTarget(targetId);
    }

    private void failTransfer(String targetId, Player player, UUID playerId, UUID sessionToken, String message) {
        if (!isCurrentSession(player, playerId, sessionToken)) {
            releaseTransfer(targetId, playerId, sessionToken);
            dispatchTarget(targetId);
            return;
        }
        player.sendMessage(Component.text(message));
        int failures = transferFailures.merge(playerId, 1, Integer::sum);
        String ticketId = ticketByPlayer.get(playerId);
        releaseTransfer(targetId, playerId, sessionToken);
        ManagerApiClient.TargetRoute route = routes.findById(targetId).orElse(null);
        Optional<RegisteredServer> fallback = route == null || route.entryProfile() == null || route.entryProfile().isBlank()
                ? Optional.empty() : proxy.getServer(route.entryProfile());
        CompletableFuture<ManagerApiClient.Ticket> pendingWrite = ticketWrites.get(playerId);
        CompletableFuture<ManagerApiClient.Ticket> priorWrite = pendingWrite == null ? CompletableFuture.completedFuture(null) : pendingWrite.handle((ticket, error) -> ticket);
        CompletableFuture<Void> recorded = priorWrite.thenCompose(ticket -> {
            String actualTicketId = ticketId != null ? ticketId : ticket == null ? null : ticket.id();
            return actualTicketId == null ? CompletableFuture.completedFuture(null) : reportTicketEvent(targetId, actualTicketId, "failed", message);
        }).exceptionally(error -> null);
        CompletableFuture<Void> moved = fallback.isPresent() && isCurrentSession(player, playerId, sessionToken) && !fallback.get().getServerInfo().getName().equals(targetId)
                ? player.createConnectionRequest(fallback.get()).connect().handle((ignored, error) -> null)
                : CompletableFuture.completedFuture(null);
        if (failures >= 3) {
            recorded.thenCompose(ignored -> moved).thenCompose(ignored -> saveOfflineTicket(player, targetId, sessionToken, "多次连接目标失败，已转为离线等待票据"))
                    .whenComplete((ticket, error) -> {
                        if (error != null) {
                            logger.warn("保存目标 {} 的离线票据失败: {}", targetId, error.getMessage());
                            return;
                        }
                        if (isCurrentSession(player, playerId, sessionToken)) player.disconnect(Component.text("连接目标服务器连续失败，已保存离线等待票据。请重新连接以继续等待。"));
                    });
            dispatchTarget(targetId);
            return;
        }
        recorded.thenCompose(ignored -> moved).thenCompose(ignored -> saveOnlineTicket(player, targetId, sessionToken)).whenComplete((ticket, error) -> {
            if (error != null) logger.warn("重新排入目标 {} 队列失败: {}", targetId, error.getMessage());
            if (!isCurrentSession(player, playerId, sessionToken)) return;
            queues.enqueue(targetId, playerId);
            proxy.getScheduler().buildTask(this, () -> dispatchTarget(targetId)).delay(5, TimeUnit.SECONDS).schedule();
        });
        dispatchTarget(targetId);
    }

    private void saveOnlineTicket(Player player, String targetId) {
        UUID sessionToken = sessionTokens.get(player.getUniqueId());
        saveOnlineTicket(player, targetId, sessionToken)
                .exceptionally(error -> { logger.warn("保存在线票据失败: {}", error.getMessage()); return null; });
    }

    private void promoteExistingTicket(Player player, String targetId, UUID sessionToken) {
        manager.activeTicketId(targetId, player.getUniqueId().toString()).thenCompose(ticketId -> {
            if (ticketId == null || !isCurrentSession(player, player.getUniqueId(), sessionToken)) return CompletableFuture.completedFuture(null);
            return saveOnlineTicket(player, targetId, sessionToken).thenAccept(ticket -> {
                if (isCurrentSession(player, player.getUniqueId(), sessionToken)
                        && proxy.getPlayer(player.getUniqueId()).flatMap(Player::getCurrentServer).map(server -> server.getServerInfo().getName().equals(targetId)).orElse(false)) {
                    ticketByPlayer.put(player.getUniqueId(), ticket.id());
                    reportTicketEvent(targetId, ticket.id(), "transferred", "离线票据重连后已直连目标服务器")
                            .whenComplete((ignored, error) -> { if (error == null) ticketByPlayer.remove(player.getUniqueId(), ticket.id()); });
                }
            });
        }).exceptionally(error -> {
            logger.warn("恢复玩家 {} 的离线票据失败: {}", player.getUniqueId(), error.getMessage());
            return null;
        });
    }

    private CompletableFuture<ManagerApiClient.Ticket> saveOnlineTicket(Player player, String targetId, UUID sessionToken) {
        UUID playerId = player.getUniqueId();
        CompletableFuture<ManagerApiClient.Ticket> pending = ticketWrites.get(playerId);
        if (pending != null) return pending;
        CompletableFuture<ManagerApiClient.Ticket> write = manager.upsertTicket(targetId, playerId.toString(), player.getUsername(), "online", "正在等待目标服务器就绪")
                .thenApply(ticket -> {
                    if (sessionToken != null && sessionToken.equals(sessionTokens.get(playerId))) ticketByPlayer.put(playerId, ticket.id());
                    return ticket;
                });
        pending = ticketWrites.putIfAbsent(playerId, write);
        if (pending != null) return pending;
        write.whenComplete((ignored, error) -> ticketWrites.remove(playerId, write));
        return write;
    }

    private CompletableFuture<ManagerApiClient.Ticket> saveOfflineTicket(Player player, String targetId, UUID sessionToken, String snapshot) {
        return manager.upsertTicket(targetId, player.getUniqueId().toString(), player.getUsername(), "offline", snapshot)
                .thenApply(ticket -> {
                    if (sessionToken != null && sessionToken.equals(sessionTokens.get(player.getUniqueId()))) ticketByPlayer.put(player.getUniqueId(), ticket.id());
                    return ticket;
                }).whenComplete((ticket, error) -> {
                    if (error != null) logger.warn("保存离线票据失败: {}", error.getMessage());
                });
    }

    private CompletableFuture<Void> reportTicketEvent(String targetId, String ticketId, String event, String snapshot) {
        return manager.ticketEvent(targetId, ticketId, event, snapshot).whenComplete((ignored, error) -> {
            if (error == null) return;
            logger.warn("提交票据事件失败: {}", error.getMessage());
        });
    }

    private void sendHeartbeat() {
        if (manager == null) return;
        List<ManagerApiClient.HeartbeatTarget> observations = routes.targets().stream().map(target -> proxy.getServer(target.id())
                .map(server -> new ManagerApiClient.HeartbeatTarget(target.id(), server.getPlayersConnected().size(), "fresh"))
                .orElseGet(() -> new ManagerApiClient.HeartbeatTarget(target.id(), 0, "unknown"))).toList();
        manager.sendHeartbeat(observations).exceptionally(error -> {
            logger.warn("发送管理器心跳失败: {}", error.getMessage());
            return null;
        });
        refreshOnlineTickets();
    }

    private void refreshOnlineTickets() {
        ticketByPlayer.forEach((playerId, ticketId) -> {
            String targetId = targetByPlayer.get(playerId);
            Player player = sessionPlayers.get(playerId);
            if (targetId == null || player == null || !proxy.getPlayer(playerId).map(current -> current == player).orElse(false)) return;
            if (connectedTargetPlayers.containsKey(playerId)) {
                reportTicketEvent(targetId, ticketId, "transferred", "已连接目标服务器")
                        .whenComplete((ignored, error) -> { if (error == null) ticketByPlayer.remove(playerId, ticketId); });
                return;
            }
            TransferLease lease = transferByTarget.get(targetId);
            if (lease != null && lease.playerId().equals(playerId)) return;
            UUID sessionToken = sessionTokens.get(playerId);
            saveOnlineTicket(player, targetId, sessionToken).exceptionally(error -> {
                logger.warn("续期玩家 {} 的在线票据失败: {}", playerId, error.getMessage());
                return null;
            });
        });
    }

    @Subscribe
    public void shutdown(ProxyShutdownEvent event) {
        if (heartbeatTask != null) heartbeatTask.cancel();
        if (configTask != null) configTask.cancel();
    }

    private final class JumpCommand implements SimpleCommand {
        @Override
        public boolean hasPermission(Invocation invocation) { return invocation.source().hasPermission("jump.admin"); }

        @Override
        public void execute(Invocation invocation) {
            String[] args = invocation.arguments();
            if (args.length == 0) {
                invocation.source().sendPlainMessage("/jump status <目标> | /jump queue <目标> | /jump test <目标> | /jump route <域名> | /jump refresh");
                return;
            }
            switch (args[0].toLowerCase()) {
                case "refresh" -> { refreshConfig(); invocation.source().sendPlainMessage("已请求刷新管理器配置。"); }
                case "status" -> {
                    if (args.length < 2) { invocation.source().sendPlainMessage("用法：/jump status <目标>"); return; }
                    routes.findById(args[1]).ifPresentOrElse(route -> invocation.source().sendPlainMessage(route.id() + " · " + route.lifecycle() + " · ready=" + route.ready()), () -> invocation.source().sendPlainMessage("未找到目标：" + args[1]));
                }
                case "test" -> {
                    if (args.length < 2) { invocation.source().sendPlainMessage("用法：/jump test <目标>"); return; }
                    manager.lifecycle(args[1]).whenComplete((status, error) -> proxy.getScheduler().buildTask(this, () -> {
                        if (error != null) { invocation.source().sendPlainMessage("管理器状态测试失败：" + error.getMessage()); return; }
                        String state = status.get("lifecycle").getAsString();
                        boolean ready = status.get("ready").getAsBoolean();
                        int players = status.get("playerCount").getAsInt();
                        invocation.source().sendPlainMessage(args[1] + " · " + state + " · ready=" + ready + " · players=" + players);
                    }).schedule());
                }
                case "queue" -> {
                    if (args.length < 2) { invocation.source().sendPlainMessage("用法：/jump queue <目标>"); return; }
                    manager.queue(args[1]).whenComplete((summary, error) -> proxy.getScheduler().buildTask(this, () -> {
                        if (error != null) { invocation.source().sendPlainMessage("队列查询失败：" + error.getMessage()); return; }
                        int online = summary.getAsJsonObject("online").get("count").getAsInt();
                        int offline = summary.getAsJsonObject("offline").get("count").getAsInt();
                        invocation.source().sendPlainMessage(args[1] + " 在线队列：" + online + " · 离线等待：" + offline);
                    }).schedule());
                }
                case "route" -> {
                    if (args.length < 2) { invocation.source().sendPlainMessage("用法：/jump route <域名>"); return; }
                    routes.resolve(args[1]).ifPresentOrElse(route -> invocation.source().sendPlainMessage(args[1] + " -> " + route.id() + "，入口：" + route.entryProfile()), () -> invocation.source().sendPlainMessage("未找到域名路由：" + args[1]));
                }
                default -> invocation.source().sendPlainMessage("未知子命令。用法：/jump status|queue|test|route|refresh");
            }
        }
    }
}
