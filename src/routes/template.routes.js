/**
 * Template management for the studio UI. Reads and writes are single queries
 * against the one templates table.
 */

const express = require('express');

const router = express.Router();

const redisState = require('../config/redis').state;
const { scanDelete } = require('../lib/redisOps');
const { publishInvalidate } = require('../lib/invalidation');
const { s3Client, PutObjectCommand } = require('../config/s3');
const { ensureTemplateSchema } = require('../db/schema');
const { requireAuth, requireAdmin } = require('../middleware/guards');
const { loadImageBuffer } = require('../services/images');
const {
  nextTemplateId,
  listTemplates,
  saveTemplate,
  deleteTemplate,
  updateBackgroundUrl,
} = require('../repositories/templateRepository');
const { S3_BUCKET_NAME } = require('../config');

router.get('/api/v1/templates/next-id', requireAuth, async (req, res) => {
  try {
    res.json({ nextId: await nextTemplateId() });
  } catch (err) {
    console.error('Error generating template ID:', err);
    res.json({ nextId: `WEB-${Math.floor(10 + Math.random() * 90)}` });
  }
});

router.get('/api/v1/templates', requireAuth, async (req, res) => {
  try {
    const cacheKey = 'templates_all';

    // Check Redis first
    if (redisState.connected) {
      try {
        const cachedList = await redisState.client.get(cacheKey);
        if (cachedList) {
          return res.json({ success: true, templates: JSON.parse(cachedList) });
        }
      } catch (err) {
        console.warn('⚠️ Redis get error:', err.message);
      }
    }

    await ensureTemplateSchema();

    const templates = await listTemplates();

    // Cache asynchronously (don't block response)
    if (redisState.connected) {
      redisState.client.set(cacheKey, JSON.stringify(templates), 'EX', 300).catch((err) => {
        console.warn('⚠️ Redis set error:', err.message);
      });
    }

    res.json({ success: true, templates });
  } catch (err) {
    console.error('Error fetching templates:', err);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

router.post('/api/v1/templates', requireAuth, async (req, res) => {
  try {
    await ensureTemplateSchema();

    let { templateId, backgroundUrl, textElements } = req.body;

    if (!templateId || !backgroundUrl || !Array.isArray(textElements)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Upload background to S3 in background (non-blocking)
    if (!backgroundUrl.includes('{{') && process.env.AWS_ACCESS_KEY_ID) {
      (async () => {
        try {
          const bgBuffer = await loadImageBuffer(backgroundUrl);
          if (bgBuffer) {
            const s3Key = `backgrounds/${templateId}-${Date.now()}.png`;
            await s3Client.send(
              new PutObjectCommand({
                Bucket: S3_BUCKET_NAME,
                Key: s3Key,
                Body: bgBuffer,
                ContentType: 'image/png',
              })
            );
            const s3Url = `https://${S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${s3Key}`;
            // Update in DB asynchronously
            updateBackgroundUrl(templateId, s3Url).catch((err) =>
              console.error('Error updating S3 URL:', err)
            );
          }
        } catch (s3Err) {
          console.warn('S3 upload skipped:', s3Err.message);
        }
      })();
    }

    // Array order is layer order, so no layer_order column is needed
    await saveTemplate({ templateId, backgroundUrl, textElements });

    await invalidateTemplateCaches(templateId);

    res.json({ success: true, templateId, message: 'Template saved successfully' });
  } catch (err) {
    console.error('Error saving template:', err);
    res.status(500).json({ error: 'Failed to save template' });
  }
});

// Removing a template is destructive and permanent, so it is admin-only. Any URL
// already rendering this template starts returning 404 once it is gone.
router.post('/api/v1/templates/:templateId/delete', requireAdmin, async (req, res) => {
  try {
    await ensureTemplateSchema();

    const { templateId } = req.params;
    const removed = await deleteTemplate(templateId);

    if (!removed) return res.status(404).json({ error: 'Template not found' });

    await invalidateTemplateCaches(templateId);

    console.log(`\ud83d\uddd1\ufe0f Template ${templateId} deleted by ${req.adminUser.email}`);
    res.json({ success: true, templateId, message: 'Template deleted' });
  } catch (err) {
    console.error('Error deleting template:', err);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

/**
 * Everything cached for one template, everywhere.
 *
 * The already-rendered PNGs have to go too, or an edited template keeps serving
 * the previous image out of render:<id>:<varHash> until that key expires. And
 * the in-process caches are per worker, so clearing them here would only fix
 * the worker that happened to handle the save — the publish is what reaches the
 * other seven.
 */
async function invalidateTemplateCaches(templateId) {
  if (redisState.connected) {
    try {
      await redisState.client.del(`template_schema:${templateId}`, 'templates_all');
      // SCAN rather than KEYS: the render cache can hold a key per variable
      // combination, and KEYS blocks the whole server while it walks them.
      await scanDelete(`render:${templateId}:*`);
    } catch (err) {
      console.warn('\u26a0\ufe0f Cache invalidation error:', err.message);
    }
  }

  publishInvalidate('template', { templateId });
}

module.exports = router;
