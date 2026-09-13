-- ============================================================================
-- Webengage Creative Studio — collapse templates + template_elements into one
-- ----------------------------------------------------------------------------
-- Before: reading the library cost 1 query for `templates` plus one per row in
-- `template_elements`; saving a template ran a transaction that deleted every
-- element row and re-inserted them.
--
-- After: a single `templates` row holds the layers in an `elements` JSON array,
-- ordered by layer. Reading is one query, saving is one upsert, and the JSON is
-- already in the shape the studio UI and the renderer use:
--
--   [
--     { "type": "text",  "x": 47, "y": 83, "text": "{{city}}?",
--       "fontSize": 16, "fontWeight": "600", "fontFamily": "Arial",
--       "color": "#ff5501", "src": null, "width": "auto", "height": "auto" },
--     { "type": "image", "x": 272, "y": 81, "src": "{{image}}",
--       "width": "163", "height": "126", "text": null, "fontSize": 24,
--       "fontWeight": "normal", "fontFamily": "Arial", "color": "#000000" }
--   ]
--
-- Prefer the script — it backfills, verifies every template, and keeps a backup
-- of the old table:
--
--   node scripts/migrate-templates-to-json.js          # backfill + verify
--   node scripts/migrate-templates-to-json.js --retire # back up to backups/ and drop
--
-- The statements below are the same steps by hand. The server also adds the
-- column and backfills it on boot (ensureTemplateSchema() in server.js), so
-- step 1 and 2 may already be done by the time you read this.
-- ============================================================================

-- Target shape ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS templates (
  template_id    VARCHAR(100) NOT NULL,
  background_url TEXT NOT NULL,
  -- Layers in draw order; NULL only on a row that predates the migration
  elements       JSON NULL,
  created_at     TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (template_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 1. Add the column to an existing table (skip if it is already there)
ALTER TABLE templates ADD COLUMN elements JSON NULL AFTER background_url;

-- 2. Backfill from the old child table, preserving layer_order
UPDATE templates t
SET t.elements = COALESCE(
  (
    SELECT JSON_ARRAYAGG(
             JSON_OBJECT(
               'type',       e.element_type,
               'x',          e.pos_x,
               'y',          e.pos_y,
               'text',       e.text_content,
               'fontSize',   e.font_size,
               'fontWeight', e.font_weight,
               'fontFamily', e.font_family,
               'color',      e.color,
               'src',        e.image_src,
               'width',      e.width,
               'height',     e.height
             )
           )
    FROM (SELECT * FROM template_elements ORDER BY template_id, layer_order) e
    WHERE e.template_id = t.template_id
  ),
  JSON_ARRAY()
)
WHERE t.elements IS NULL;

-- 3. Check every template carried over before removing anything
SELECT t.template_id,
       JSON_LENGTH(t.elements)                AS json_layers,
       (SELECT COUNT(*) FROM template_elements e
         WHERE e.template_id = t.template_id) AS legacy_layers
FROM templates t;

-- 4. Retire the old table once step 3 shows matching counts, so `templates` is
--    the only template table left. The script writes the old rows to backups/
--    as JSON before this point; do the same by hand (mysqldump) if you want a
--    copy, because a backup table would just leave two tables again.
DROP TABLE template_elements;
