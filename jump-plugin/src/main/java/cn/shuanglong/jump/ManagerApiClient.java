package cn.shuanglong.jump;

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

    private final HttpClient client;
    private final Gson gson = new Gson();
    private final String baseUrl;
    private final String proxyId;
    private final String token;
    private final Duration timeout;

    public ManagerApiClient(String baseUrl, String proxyId, String token, Duration timeout) {
        this.client = HttpClient.newBuilder().connectTimeout(timeout).build();
        this.baseUrl = baseUrl.replaceAll("/$", "");
        this.proxyId = proxyId;
        this.token = token;
        this.timeout = timeout;
    }

    public CompletableFuture<Config> fetchConfig() {
        HttpRequest request = request("/api/v1/proxy/config").GET().build();
        return client.sendAsync(request, HttpResponse.BodyHandlers.ofString()).thenApply(response -> {
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
            return new Config(routes);
        });
    }

    public CompletableFuture<Void> sendHeartbeat(List<HeartbeatTarget> targets) {
        JsonObject body = new JsonObject();
        body.addProperty("observedAt", java.time.Instant.now().toString());
        var array = new com.google.gson.JsonArray();
        targets.forEach(target -> { JsonObject item = new JsonObject(); item.addProperty("targetId", target.targetId()); item.addProperty("playerCount", target.playerCount()); item.addProperty("quality", target.quality()); array.add(item); });
        body.add("targets", array);
        HttpRequest request = request("/api/v1/proxy/heartbeat").POST(HttpRequest.BodyPublishers.ofString(gson.toJson(body))).build();
        return client.sendAsync(request, HttpResponse.BodyHandlers.discarding()).thenAccept(response -> { if (response.statusCode() / 100 != 2) throw new IllegalStateException("管理器心跳失败: " + response.statusCode()); });
    }

    public CompletableFuture<JsonObject> wake(String targetId, String idempotencyKey) {
        HttpRequest request = request("/api/v1/proxy/targets/" + encode(targetId) + "/wake").header("Idempotency-Key", idempotencyKey).POST(HttpRequest.BodyPublishers.noBody()).build();
        return client.sendAsync(request, HttpResponse.BodyHandlers.ofString()).thenApply(response -> { if (response.statusCode() / 100 != 2) throw new IllegalStateException("唤醒失败: " + response.statusCode()); return JsonParser.parseString(response.body()).getAsJsonObject(); });
    }

    private HttpRequest.Builder request(String path) { return HttpRequest.newBuilder(URI.create(baseUrl + path)).timeout(timeout).header("Authorization", "Bearer " + token).header("Accept", "application/json").header("Content-Type", "application/json").header("X-Proxy-Id", proxyId); }
    private static String encode(String value) { return java.net.URLEncoder.encode(value, java.nio.charset.StandardCharsets.UTF_8); }
    public record HeartbeatTarget(String targetId, int playerCount, String quality) {}
}
