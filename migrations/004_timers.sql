-- ============================================================================
-- Webengage Creative Studio — countdown timers
-- ----------------------------------------------------------------------------
-- A saved timer is a creative plus the styling of the clock drawn on it. The
-- creative is either a studio template (`source.templateId`, so the artwork can
-- carry {{placeholders}} of its own) or a plain image URL.
--
-- Everything else lives in one JSON column, for the same reason templates.elements
-- does: the object is stored in exactly the shape the builder UI edits and the
-- GIF renderer reads, so nothing has to be mapped on either side.
--
--   {
--     "source":    { "templateId": "WEB-04", "backgroundUrl": "" },
--     "endAt":     "2026-12-31 23:59:59",
--     "timezone":  "Asia/Kolkata",
--     "evergreenSeconds": 0,
--     "canvasWidth": 600,
--     "background": "#ffffff",
--     "colors": 256,
--     "frames": 60,
--     "style":   { "x": 0.5, "y": 0.56, "units": ["days","hours","minutes","seconds"],
--                  "fontFamily": "Arial", "fontSize": 52, "fontWeight": "bold",
--                  "color": "#ffffff", "separator": ":", "gap": 10,
--                  "showLabels": true, "labels": { "days": "DAYS", ... },
--                  "plate": { "mode": "unit", "color": "#000000", "opacity": 0.45,
--                             "radius": 10, "padX": 18, "padY": 14 } },
--     "expired": { "mode": "message", "text": "SALE ENDED", "color": "#ffffff" }
--   }
--
-- The deadline is stored as written rather than as a UTC instant, because it is
-- meaningful together with `timezone` ("midnight, wherever the sale is running")
-- and because a URL may override it per campaign.
--
-- The server applies this on boot (ensureTimerSchema() in src/db/schema.js), so
-- this file is for review and for applying by hand:
--
--   mysql -u root -p personalize_studio < migrations/004_timers.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS timers (
  timer_id   VARCHAR(100) NOT NULL,
  name       VARCHAR(190) NOT NULL,
  config     JSON NOT NULL,
  created_by INT UNSIGNED NULL DEFAULT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (timer_id),
  KEY idx_timers_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
