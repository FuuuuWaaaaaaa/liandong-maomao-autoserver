package cn.shuanglong.jump;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RouteResolverTest {
    @Test
    void resolvesCaseInsensitiveHostAndTrailingDot() {
        RouteResolver resolver = new RouteResolver();
        resolver.replace(new ManagerApiClient.Config(List.of(new ManagerApiClient.TargetRoute("survival", "生存世界", List.of("Play.Example.Net"), "lobby", "OFFLINE", false))));
        assertTrue(resolver.resolve("play.example.net.").isPresent());
        assertEquals("survival", resolver.resolve("PLAY.EXAMPLE.NET").orElseThrow().id());
    }
}
