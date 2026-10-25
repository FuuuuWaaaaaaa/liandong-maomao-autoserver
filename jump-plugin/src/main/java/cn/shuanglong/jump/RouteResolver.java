package cn.shuanglong.jump;

import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;

public final class RouteResolver {
    private final AtomicReference<ManagerApiClient.Config> config = new AtomicReference<>(new ManagerApiClient.Config(List.of()));

    public void replace(ManagerApiClient.Config next) { config.set(next); }
    public Optional<ManagerApiClient.TargetRoute> resolve(String hostname) {
        if (hostname == null) return Optional.empty();
        String canonical = hostname.trim().toLowerCase(Locale.ROOT).replaceAll("\\.$", "");
        return config.get().targets().stream().filter(target -> target.aliases().stream().map(alias -> alias.toLowerCase(Locale.ROOT).replaceAll("\\.$", "")).anyMatch(canonical::equals)).findFirst();
    }
    public List<ManagerApiClient.TargetRoute> targets() { return config.get().targets(); }
}
