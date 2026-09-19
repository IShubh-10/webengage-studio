/**
 * Template reads and writes. Layers live in the templates.elements JSON column
 * in draw order, in exactly the shape the studio UI and the renderer use, so
 * there is no column mapping on either side.
 */

const db = require('../config/db');

function parseElements(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.warn('⚠️ Could not parse elements JSON:', err.message);
      return [];
    }
  }

  return [];
}

// Same fields and defaults the element columns used to enforce, so what comes
// back out of JSON is exactly what the old SELECT produced.
function normalizeElement(element) {
  const type = element && element.type === 'image' ? 'image' : 'text';

  return {
    type,
    x: parseInt(element.x, 10) || 0,
    y: parseInt(element.y, 10) || 0,
    text: element.text ? String(element.text) : null,
    fontSize: parseInt(element.fontSize, 10) || 24,
    fontWeight: element.fontWeight || 'normal',
    fontFamily: element.fontFamily || 'Arial',
    color: element.color || '#000000',
    src: element.src ? String(element.src) : null,
    width: String(element.width || 'auto'),
    height: String(element.height || 'auto'),
    // How the overlay fills its width x height box. Anything unrecognised (and
    // every element saved before this field existed) stays 'contain'.
    fit: element.fit === 'cover' || element.fit === 'fill' ? element.fit : 'contain',
  };
}

async function nextTemplateId() {
  const [rows] = await db.query(
    "SELECT template_id FROM templates WHERE template_id REGEXP '^WEB-[0-9]+$' ORDER BY CAST(SUBSTRING(template_id, 5) AS UNSIGNED) DESC LIMIT 1"
  );

  if (rows.length === 0) return 'WEB-01';

  const num = parseInt(rows[0].template_id.replace('WEB-', ''), 10) + 1;
  return `WEB-${String(num).padStart(2, '0')}`;
}

/*
 * One query for the whole library — the layers travel with the row, and so
 * does the author, which the studio needs to say whose template this is and to
 * decide who may change it. LEFT JOIN, so a template outlives the account that
 * made it instead of disappearing from everyone's library.
 *
 * Note what is *not* here: whether the current viewer may edit. This result is
 * shared between users through the Redis list cache, so a per-viewer answer
 * must be computed after the cache, not inside it.
 */
async function listTemplates() {
  const [rows] = await db.query(
    `SELECT t.template_id, t.background_url, t.elements, t.created_at, t.created_by,
            u.name AS created_by_name
       FROM templates t
       LEFT JOIN users u ON u.id = t.created_by
      ORDER BY t.created_at DESC`
  );

  return rows.map((row) => ({
    template_id: row.template_id,
    background_url: row.background_url,
    created_at: row.created_at,
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    textElements: parseElements(row.elements),
  }));
}

/**
 * Who owns a template, for the permission check before a write. Null when
 * there is no such row, so a caller can answer 403 and 404 distinctly.
 * `createdBy` is null for rows written before ownership was recorded.
 */
async function templateOwner(templateId) {
  const [rows] = await db.query('SELECT created_by FROM templates WHERE template_id = ?', [
    templateId,
  ]);
  if (rows.length === 0) return null;
  return { createdBy: rows[0].created_by };
}

async function findTemplate(templateId) {
  const [rows] = await db.query(
    'SELECT background_url, elements FROM templates WHERE template_id = ?',
    [templateId]
  );

  if (rows.length === 0) return null;

  return {
    background_url: rows[0].background_url,
    elements: parseElements(rows[0].elements),
  };
}

/*
 * One upsert replaces the old transaction + delete + bulk insert.
 *
 * `created_by` is set on insert and left alone on update, so an admin editing
 * somebody's template does not quietly take ownership of it.
 */
async function saveTemplate({ templateId, backgroundUrl, textElements, createdBy = null }) {
  const elementsJson = JSON.stringify(
    textElements.filter((el) => el && typeof el === 'object').map(normalizeElement)
  );

  await db.query(
    `INSERT INTO templates (template_id, background_url, elements, created_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         background_url = VALUES(background_url),
         elements = VALUES(elements)`,
    [templateId, backgroundUrl, elementsJson, createdBy]
  );
}

async function deleteTemplate(templateId) {
  const [result] = await db.query('DELETE FROM templates WHERE template_id = ?', [templateId]);
  return result.affectedRows > 0;
}

function updateBackgroundUrl(templateId, url) {
  return db.query('UPDATE templates SET background_url = ? WHERE template_id = ?', [url, templateId]);
}

/**
 * Ids and owners only, for the stats page.
 *
 * `listTemplates` pulls every layer of every template as JSON, which is a lot
 * of bytes to move to answer "what is this creative called". The stats table
 * needs a row per creative and nothing else.
 */
async function listTemplateNames() {
  const [rows] = await db.query(
    `SELECT t.template_id, t.created_by, u.name AS created_by_name
       FROM templates t
       LEFT JOIN users u ON u.id = t.created_by
      ORDER BY t.template_id ASC`
  );

  return rows.map((row) => ({
    id: row.template_id,
    name: row.template_id,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
  }));
}

module.exports = {
  parseElements,
  normalizeElement,
  nextTemplateId,
  listTemplates,
  listTemplateNames,
  findTemplate,
  templateOwner,
  saveTemplate,
  deleteTemplate,
  updateBackgroundUrl,
};
