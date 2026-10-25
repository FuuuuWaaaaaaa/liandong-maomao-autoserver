package cn.shuanglong.jump;

import com.velocitypowered.api.proxy.Player;

import java.time.Duration;
import java.util.ArrayDeque;
import java.util.Map;
import java.util.Queue;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/** 每个目标独立串行，通知倒计时期间不会被新玩家打断。 */
public final class QueueCoordinator {
    private final Map<String, Queue<UUID>> queues = new ConcurrentHashMap<>();
    private final Duration notice;
    public QueueCoordinator(Duration notice) { this.notice = notice; }
    public void enqueue(String targetId, Player player) { queues.computeIfAbsent(targetId, ignored -> new ArrayDeque<>()).offer(player.getUniqueId()); }
    public UUID poll(String targetId) { Queue<UUID> queue = queues.get(targetId); return queue == null ? null : queue.poll(); }
    public int size(String targetId) { Queue<UUID> queue = queues.get(targetId); return queue == null ? 0 : queue.size(); }
    public Duration noticeDuration() { return notice; }
}
