-- Wreso database schema (MySQL 8+ / MariaDB 10.6+)

CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email         VARCHAR(255) NOT NULL,
  name          VARCHAR(120) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS projects (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NOT NULL,
  name        VARCHAR(200) NOT NULL,
  description TEXT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_projects_user (user_id),
  CONSTRAINT fk_projects_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS media (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id    INT UNSIGNED NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  filename      VARCHAR(255) NOT NULL,
  mime          VARCHAR(120) NOT NULL,
  kind          ENUM('video','audio','image') NOT NULL,
  size_bytes    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  duration      DOUBLE NULL,
  width         INT NULL,
  height        INT NULL,
  fps           DOUBLE NULL,
  has_video     TINYINT(1) NOT NULL DEFAULT 0,
  has_audio     TINYINT(1) NOT NULL DEFAULT 0,
  thumbnail     VARCHAR(255) NULL,
  waveform      VARCHAR(255) NULL,
  proxy         VARCHAR(255) NULL COMMENT 'browser-friendly copy used by the preview player',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_media_project (project_id),
  CONSTRAINT fk_media_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A composition is a timeline with its own canvas (width x height, fps, background).
CREATE TABLE IF NOT EXISTS compositions (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id       INT UNSIGNED NOT NULL,
  name             VARCHAR(200) NOT NULL,
  width            INT NOT NULL DEFAULT 1920,
  height           INT NOT NULL DEFAULT 1080,
  fps              DOUBLE NOT NULL DEFAULT 30,
  background_color VARCHAR(9) NOT NULL DEFAULT '#000000',
  duration         DOUBLE NULL COMMENT 'NULL = automatic (end of last clip)',
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_compositions_project (project_id),
  CONSTRAINT fk_compositions_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tracks (
  id             CHAR(36) NOT NULL,
  composition_id INT UNSIGNED NOT NULL,
  kind           ENUM('video','audio') NOT NULL,
  name           VARCHAR(100) NOT NULL,
  position       INT NOT NULL DEFAULT 0,
  muted          TINYINT(1) NOT NULL DEFAULT 0,
  hidden         TINYINT(1) NOT NULL DEFAULT 0,
  volume         DOUBLE NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY idx_tracks_composition (composition_id),
  CONSTRAINT fk_tracks_composition FOREIGN KEY (composition_id) REFERENCES compositions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A clip is a piece of a source (media file or another composition) placed on a track.
-- Duration on the timeline = (source_out - source_in) / speed.
CREATE TABLE IF NOT EXISTS clips (
  id                    CHAR(36) NOT NULL,
  track_id              CHAR(36) NOT NULL,
  composition_id        INT UNSIGNED NOT NULL,
  source_type           ENUM('media','composition') NOT NULL,
  media_id              INT UNSIGNED NULL,
  source_composition_id INT UNSIGNED NULL,
  timeline_start        DOUBLE NOT NULL DEFAULT 0,
  source_in             DOUBLE NOT NULL DEFAULT 0,
  source_out            DOUBLE NOT NULL,
  speed                 DOUBLE NOT NULL DEFAULT 1,
  volume                DOUBLE NOT NULL DEFAULT 1,
  muted                 TINYINT(1) NOT NULL DEFAULT 0,
  fade_in               DOUBLE NOT NULL DEFAULT 0,
  fade_out              DOUBLE NOT NULL DEFAULT 0,
  crop_left             DOUBLE NOT NULL DEFAULT 0,
  crop_top              DOUBLE NOT NULL DEFAULT 0,
  crop_right            DOUBLE NOT NULL DEFAULT 0,
  crop_bottom           DOUBLE NOT NULL DEFAULT 0,
  pos_x                 DOUBLE NOT NULL DEFAULT 0,
  pos_y                 DOUBLE NOT NULL DEFAULT 0,
  scale                 DOUBLE NOT NULL DEFAULT 1,
  opacity               DOUBLE NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY idx_clips_track (track_id),
  KEY idx_clips_composition (composition_id),
  KEY idx_clips_media (media_id),
  KEY idx_clips_source_comp (source_composition_id),
  CONSTRAINT fk_clips_track FOREIGN KEY (track_id) REFERENCES tracks (id) ON DELETE CASCADE,
  CONSTRAINT fk_clips_composition FOREIGN KEY (composition_id) REFERENCES compositions (id) ON DELETE CASCADE,
  CONSTRAINT fk_clips_media FOREIGN KEY (media_id) REFERENCES media (id) ON DELETE CASCADE,
  CONSTRAINT fk_clips_source_comp FOREIGN KEY (source_composition_id) REFERENCES compositions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS renders (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  composition_id INT UNSIGNED NOT NULL,
  status         ENUM('queued','processing','done','failed') NOT NULL DEFAULT 'queued',
  progress       DOUBLE NOT NULL DEFAULT 0,
  output_file    VARCHAR(255) NULL,
  error          TEXT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at    TIMESTAMP NULL,
  PRIMARY KEY (id),
  KEY idx_renders_composition (composition_id),
  CONSTRAINT fk_renders_composition FOREIGN KEY (composition_id) REFERENCES compositions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
