package cn.liandongmaomao.jump;

import org.slf4j.Logger;
import org.yaml.snakeyaml.Yaml;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.Collections;
import java.util.Map;

/** 从 Velocity 数据目录加载传统 config.yml；敏感令牌支持环境变量占位符。 */
public final class PluginConfig {
    public record Values(String managerUrl, String proxyId, String token, Duration requestTimeout,
                         long configRefreshSeconds, long heartbeatSeconds,
                         long transferNoticeSeconds, long transferStabilitySeconds) {}

    private PluginConfig() {}

    public static Values load(Path dataDirectory, Logger logger) throws IOException {
        Files.createDirectories(dataDirectory);
        Path configFile = dataDirectory.resolve("config.yml");
        if (Files.notExists(configFile)) {
            try (InputStream bundled = PluginConfig.class.getResourceAsStream("/config.yml")) {
                if (bundled == null) throw new IOException("插件内置 config.yml 不存在");
                Files.copy(bundled, configFile, StandardCopyOption.REPLACE_EXISTING);
            }
            logger.info("已生成默认插件配置: {}", configFile);
        }

        Map<String, Object> root;
        try (InputStream input = Files.newInputStream(configFile)) {
            Object parsed = new Yaml().load(input);
            root = asMap(parsed);
        }
        Map<String, Object> manager = asMap(root.get("manager"));
        String managerUrl = string(manager, "base-url", "http://127.0.0.1:8080");
        String proxyId = string(manager, "proxy-id", "proxy-main");
        String token = resolveSecret(string(manager, "token", ""));
        long timeoutMs = positiveLong(manager, "request-timeout-ms", 5000);
        long refreshSeconds = positiveLong(manager, "config-refresh-seconds", 30);
        long heartbeatSeconds = positiveLong(manager, "heartbeat-seconds", 15);
        Map<String, Object> queue = asMap(root.get("queue"));
        long noticeSeconds = positiveLong(queue, "transfer-notice-seconds", 5);
        long stabilitySeconds = positiveLong(queue, "transfer-stability-seconds", 2);
        return new Values(managerUrl, proxyId, token, Duration.ofMillis(timeoutMs), refreshSeconds, heartbeatSeconds, noticeSeconds, stabilitySeconds);
    }

    private static String resolveSecret(String value) {
        if (value.startsWith("${") && value.endsWith("}")) {
            String environmentName = value.substring(2, value.length() - 1);
            return System.getenv().getOrDefault(environmentName, "");
        }
        return value;
    }

    private static String string(Map<String, Object> map, String key, String fallback) {
        Object value = map.get(key);
        return value == null ? fallback : String.valueOf(value).trim();
    }

    private static long positiveLong(Map<String, Object> map, String key, long fallback) {
        Object value = map.get(key);
        if (value == null) return fallback;
        try {
            long parsed = Long.parseLong(String.valueOf(value));
            if (parsed > 0) return parsed;
        } catch (NumberFormatException ignored) {
            // 使用安全默认值并在启动日志中保持可诊断性。
        }
        return fallback;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object value) {
        return value instanceof Map<?, ?> map ? (Map<String, Object>) map : Collections.emptyMap();
    }
}
