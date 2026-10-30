package cn.liandongmaomao.jump;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/** 管理器只接收代理令牌，永远不会把 Pterodactyl 凭证带进来。 */
public final class ManagerApiClient {
    public record TargetRoute(String id, String displayName, List<String> aliases, String entryProfile, String lifecycle, boolean ready) {}
    public record Config(List<TargetRoute> targets) {}
    public record Ticket(String id, String targetId, String state, int onlineCount, int onlinePosition, int offlineCount, int offlinePosition) {}

    private final HttpClient client;
    private final Gson gson = new Gson();
    private final String baseUrl;
    private final String proxyId;
    private final String token;
    private final Duration timeout;
    private volatile Config cachedConfig;
    private volatile String configEtag;

    public ManagerApiClient(String baseUrl, String proxyId, String token, Duration timeout) {
        this.client = HttpClient.newBuilder().connectTimeout(timeout).build();
        this.baseUrl = baseUrl.replaceAll("/$", "");
        this.proxyId = proxyId;
        this.token = token;
        this.timeout = timeout;
    }

    public CompletableFuture<Config> fetchConfig() {
        HttpRequest.Builder builder = request("/api/v1/proxy/config").GET();
        if (configEtag != null) builder.header("If-None-Match", configEtag);
        HttpRequest request = builder.build();
        return client.sendAsync(request, HttpResponse.BodyHandlers.ofString()).thenApply(response -> {
            if (response.statusCode() == 304 && cachedConfig != null) return cachedConfig;
            if (response.statusCode() / 100 != 2) throw new IllegalStateException("管理器配置请求失败: " + response.statusCode());
            JsonObject root = JsonParser.parseString(response.body()).getAsJsonObject();
            List<TargetRoute> routes = new ArrayList<>();
            root.getAsJsonArray("targets").forEach(item -> {
                JsonObject target = item.getAsJsonObject();
                List<String> aliases = new ArrayList<>();
                target.getAsJsonArray("aliases").forEach(alias -> aliases.add(alias.getAsString()));
                routes.add(new TargetRoute(target.get("id").getAsString(), target.get("displayName").getAsString(), aliases,
                        target.has("entryProfile") && !target.get("entryProfile").isJsonNull() ? target.get("entryProfile").getAsString() : "",
                        target.get("lifecycle").getAsString(), target.get("ready").getAsBoolean()));
            });
            Config next = new Config(routes);
            cachedConfig = next;
            response.headers().firstValue("ETag").ifPresent(value -> configEtag = value);
            return next;
        });
    }

    public CompletableFuture<Void> sendHeartbeat(List<HeartbeatTarget> targets) {
        JsonObject body = new JsonObject();
        body.addProperty("observedAt", java.time.Instant.now().toString());
        body.addProperty("pluginVersion", PluginVersion.VALUE);
        body.addProperty("apiVersion", "v1");
        var array = new com.google.gson.JsonArray();
        targets.forEach(target -> { JsonObject item = new JsonObject(); item.addProperty("targetId", target.targetId()); item.addProperty("playerCount", target.playerCount()); item.addProperty("quality", target.quality()); array.add(item); });
        body.add("targets", array);
        HttpRequest request = request("/api/v1/proxy/heartbeat").POST(HttpRequest.BodyPublishers.ofString(gson.toJson(body))).build();
        return client.sendAsync(request, HttpResponse.BodyHandlers.discarding()).thenAccept(response -> { if (response.statusCode() / 100 != 2) throw new IllegalStateException("管理器心跳失败: " + response.statusCode()); });
    }

    public CompletableFuture<JsonObject> wake(String targetId, String idempotencyKey) {
        HttpRequest request = request("/api/v1/proxy/targets/" + encode(targetId) + "/wake").header("Idempotency-Key", idempotencyKey).POST(HttpRequest.BodyPublishers.ofString("{}")).build();
        return client.sendAsync(request, HttpResponse.BodyHandlers.ofString()).thenApply(response -> {
            if (response.statusCode() / 100 != 2) throw new IllegalStateException("唤醒失败: " + response.statusCode());
            JsonObject body = JsonParser.parseString(response.body()).getAsJsonObject();
            if (body.has("accepted") && !body.get("accepted").getAsBoolean()) throw new IllegalStateException("目标唤醒请求未接受: " + (body.has("reason") ? body.get("reason").getAsString() : "未知原因"));
            return body;
        });
    }

    public CompletableFuture<JsonObject> lifecycle(String targetId) { return getObject("/api/v1/proxy/targets/" + encode(targetId) + "/lifecycle", "生命周期请求失败"); }

    public CompletableFuture<JsonObject> queue(String targetId) { return getObject("/api/v1/proxy/targets/" + encode(targetId) + "/queue", "队列请求失败"); }

    private CompletableFuture<JsonObject> getObject(String path, String errorMessage) {
        HttpRequest request = request(path).GET().build();
        return client.sendAsync(request, HttpResponse.BodyHandlers.ofString()).thenApply(response -> {
            if (response.statusCode() / 100 != 2) throw new IllegalStateException(errorMessage + ": " + response.statusCode());
            return JsonParser.parseString(response.body()).getAsJsonObject();
        });
    }

    public CompletableFuture<Ticket> upsertTicket(String targetId, String playerUuid, String playerName, String ticketClass, String snapshot) {
        JsonObject body = new JsonObject();
        body.addProperty("playerUuid", playerUuid);
        if (playerName != null && !playerName.isBlank()) body.addProperty("playerName", playerName);
        body.addProperty("ticketClass", ticketClass);
        if (snapshot != null) body.addProperty("snapshot", snapshot);
        HttpRequest request = request("/api/v1/proxy/targets/" + encode(targetId) + "/tickets")
                .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(body))).build();
        return client.sendAsync(request, HttpResponse.BodyHandlers.ofString()).thenApply(response -> {
            if (response.statusCode() / 100 != 2) throw new IllegalStateException("票据请求失败: " + response.statusCode());
            JsonObject root = JsonParser.parseString(response.body()).getAsJsonObject();
            JsonObject ticket = root.getAsJsonObject("ticket");
            JsonObject queue = root.getAsJsonObject("queue");
            JsonObject online = queue.getAsJsonObject("online");
            JsonObject offline = queue.getAsJsonObject("offline");
            return new Ticket(ticket.get("id").getAsString(), targetId, ticket.get("state").getAsString(),
                    online.get("count").getAsInt(), optionalInt(online, "position"), offline.get("count").getAsInt(), optionalInt(offline, "position"));
        });
    }

    public CompletableFuture<String> activeTicketId(String targetId, String playerUuid) {
        HttpRequest request = request("/api/v1/proxy/targets/" + encode(targetId) + "/tickets/player/" + encode(playerUuid)).GET().build();
        return client.sendAsync(request, HttpResponse.BodyHandlers.ofString()).thenApply(response -> {
            if (response.statusCode() == 404) return null;
            if (response.statusCode() / 100 != 2) throw new IllegalStateException("活动票据查询失败: " + response.statusCode());
            JsonObject root = JsonParser.parseString(response.body()).getAsJsonObject();
            return root.getAsJsonObject("ticket").get("id").getAsString();
        });
    }

    public CompletableFuture<Void> ticketEvent(String targetId, String ticketId, String event, String snapshot) {
        JsonObject body = new JsonObject();
        body.addProperty("event", event);
        if (snapshot != null) body.addProperty("snapshot", snapshot);
        HttpRequest request = request("/api/v1/proxy/targets/" + encode(targetId) + "/tickets/" + encode(ticketId) + "/events")
                .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(body))).build();
        return client.sendAsync(request, HttpResponse.BodyHandlers.discarding()).thenAccept(response -> {
            if (response.statusCode() / 100 != 2) throw new IllegalStateException("票据事件失败: " + response.statusCode());
        });
    }

    private static int optionalInt(JsonObject object, String key) { return object.has(key) && !object.get(key).isJsonNull() ? object.get(key).getAsInt() : 0; }

    private HttpRequest.Builder request(String path) { return HttpRequest.newBuilder(URI.create(baseUrl + path)).timeout(timeout).header("Authorization", "Bearer " + token).header("Accept", "application/json").header("Content-Type", "application/json").header("X-Proxy-Id", proxyId); }
    private static String encode(String value) { return java.net.URLEncoder.encode(value, java.nio.charset.StandardCharsets.UTF_8); }
    public record HeartbeatTarget(String targetId, int playerCount, String quality) {}
}
