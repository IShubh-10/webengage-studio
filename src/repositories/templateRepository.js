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

// One query for the whole library — the layers travel with the row
async function listTemplates() {
  const [rows] = await db.query(
    'SELECT template_id, background_url, elements, created_at FROM templates ORDER BY created_at DESC'
  );

  return rows.map((row) => ({
    template_id: row.template_id,
    background_url: row.background_url,
    created_at: row.created_at,
    textElements: parseElements(row.elements),
  }));
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

// One upsert replaces the old transaction + delete + bulk insert
async function saveTemplate({ templateId, backgroundUrl, textElements }) {
  const elementsJson = JSON.stringify(
    textElements.filter((el) => el && typeof el === 'object').map(normalizeElement)
  );

  await db.query(
    `INSERT INTO templates (template_id, background_url, elements)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         background_url = VALUES(background_url),
         elements = VALUES(elements)`,
    [templateId, backgroundUrl, elementsJson]
  );
}

async function deleteTemplate(templateId) {
  const [result] = await db.query('DELETE FROM templates WHERE template_id = ?', [templateId]);
  return result.affectedRows > 0;
}

function updateBackgroundUrl(templateId, url) {
  return db.query('UPDATE templates SET background_url = ? WHERE template_id = ?', [url, templateId]);
}

module.exports = {
  parseElements,
  normalizeElement,
  nextTemplateId,
  listTemplates,
  findTemplate,
  saveTemplate,
  deleteTemplate,
  updateBackgroundUrl,
};
