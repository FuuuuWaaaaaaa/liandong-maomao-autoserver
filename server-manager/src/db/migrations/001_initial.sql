CREATE TABLE IF NOT EXISTS target_servers (
  id VARCHAR(64) PRIMARY KEY,
  slug VARCHAR(128) NOT NULL UNIQUE,
  display_name VARCHAR(128) NOT NULL,
  aliases JSON NOT NULL,
  panel_server_identifier VARCHAR(128),
  backend_host VARCHAR(255), backend_port INT,
  software VARCHAR(64), loader VARCHAR(64), minecraft_version VARCHAR(32), entry_profile VARCHAR(128),
  raw_state VARCHAR(32) NOT NULL DEFAULT 'offline', normalized_state VARCHAR(32) NOT NULL DEFAULT 'OFFLINE', readiness BOOLEAN NOT NULL DEFAULT 0,
  player_count INT NOT NULL DEFAULT 0, heartbeat_at DATETIME(3), zero_since DATETIME(3), last_error TEXT,
  startup_timeout_seconds INT NOT NULL DEFAULT 300, idle_timeout_seconds INT NOT NULL DEFAULT 900,
  enabled BOOLEAN NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS domain_routes (
  id CHAR(36) PRIMARY KEY, normalized_hostname VARCHAR(255) NOT NULL UNIQUE, target_id VARCHAR(64) NOT NULL, route_enabled BOOLEAN NOT NULL DEFAULT 1,
  CONSTRAINT fk_route_target FOREIGN KEY (target_id) REFERENCES target_servers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS proxy_instances (
  id VARCHAR(64) PRIMARY KEY, name VARCHAR(128) NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE, token_hint VARCHAR(16), enabled BOOLEAN NOT NULL DEFAULT 1,
  last_seen_at DATETIME(3), plugin_version VARCHAR(64), api_version VARCHAR(16), created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS presence_snapshots (
  id CHAR(36) PRIMARY KEY, proxy_id VARCHAR(64) NOT NULL, target_id VARCHAR(64) NOT NULL, observed_at DATETIME(3) NOT NULL, player_count INT NOT NULL, quality VARCHAR(16) NOT NULL DEFAULT 'fresh',
  INDEX idx_presence_target_time (target_id, observed_at), CONSTRAINT fk_presence_target FOREIGN KEY (target_id) REFERENCES target_servers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS queue_tickets (
  id CHAR(36) PRIMARY KEY, target_id VARCHAR(64) NOT NULL, player_uuid CHAR(36) NOT NULL, last_player_name VARCHAR(32), ticket_class ENUM('online','offline') NOT NULL, state ENUM('waiting','promoted','transferred','failed','expired') NOT NULL,
  enqueue_sequence BIGINT NOT NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, expires_at DATETIME(3) NOT NULL, last_status_snapshot TEXT,
  active_player_key VARCHAR(128) AS (IF(state IN ('waiting','promoted'), CONCAT(target_id, ':', player_uuid), NULL)) STORED,
  UNIQUE KEY uq_active_ticket (active_player_key), INDEX idx_queue_target_state (target_id, state, enqueue_sequence), CONSTRAINT fk_ticket_target FOREIGN KEY (target_id) REFERENCES target_servers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS queue_events (
  id CHAR(36) PRIMARY KEY, ticket_id CHAR(36) NOT NULL, event_type VARCHAR(32) NOT NULL, source VARCHAR(32) NOT NULL, payload JSON, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_event_ticket FOREIGN KEY (ticket_id) REFERENCES queue_tickets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS lifecycle_operations (
  id CHAR(36) PRIMARY KEY, target_id VARCHAR(64) NOT NULL, operation ENUM('start','stop','restart') NOT NULL, idempotency_key VARCHAR(255) NOT NULL, requested_by VARCHAR(128), outcome VARCHAR(32) NOT NULL, error TEXT, started_at DATETIME(3), finished_at DATETIME(3),
  UNIQUE KEY uq_lifecycle_idempotency (target_id, idempotency_key), CONSTRAINT fk_operation_target FOREIGN KEY (target_id) REFERENCES target_servers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS audit_log (
  id CHAR(36) PRIMARY KEY, actor VARCHAR(128) NOT NULL, action VARCHAR(64) NOT NULL, object_type VARCHAR(64) NOT NULL, object_id VARCHAR(128), summary JSON, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
