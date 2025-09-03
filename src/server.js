/**
 * DTCA Apply API - full server.js
 * - Express API for Shopify form
 * - Maps answers -> ClickUp custom fields
 * - Uploads optional video attachment
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const os = require('os');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// WHATWG fetch + FormData/Blob for Node
const { FormData, Blob } = globalThis;
const fetch =
  global.fetch ||
  ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 300 * 1024 * 1024 }, // 300 MB
  fileFilter(req, file, cb) {
    // Allow if no file here; we will hard-require in the route for clear UX
    if (!file) return cb(null, true);
    if (file.mimetype && file.mimetype.startsWith('video/')) return cb(null, true);
    return cb(new Error('INVALID_FILETYPE'));
  }
});

// ---------------------------------------------------------------------------
// Config
const PORT = process.env.PORT || 8000;
const CLICKUP_TOKEN = process.env.CLICKUP_TOKEN;
const CLICKUP_LIST_ID = process.env.CLICKUP_LIST_ID;

// Custom-field IDs from .env (and a few known hard-coded where you asked)
const CF = {
  ENGAGEMENT_REQ: process.env.CF_ENGAGEMENT_REQ,        // long text
  ADDITIONAL_COMMENTS: process.env.CF_ADDITIONAL_COMMENTS, // long text
  EMAIL: process.env.CF_EMAIL,                                   // short text
  PHONE: process.env.CF_PHONE,                                   // short text
  LOCATION: process.env.CF_LOCATION,                             // dropdown or text
  OTHER_LOCATION: process.env.CF_OTHER_LOCATION,                 // short text
  WORK_ELIGIBILITY: process.env.CF_WORK_ELIGIBILITY || 'aec8f523-e21d-4cd7-a359-d52f712009cb', // dropdown
  RELIABLE_COMPUTER: process.env.CF_RELIABLE_COMPUTER || 'ba53f6aa-997f-4af6-9e52-dd4e76c31723', // dropdown
  EXPERIENCE_DESC: process.env.CF_EXPERIENCE_DESC,               // long text
  CERT_COMPLETED: process.env.CF_CERT_COMPLETED,                 // dropdown or text
  CERT_LISTED: process.env.CF_CERT_LISTED,                       // long text
  EDUCATION: process.env.CF_EDUCATION || '54a767b7-175a-46b6-b380-741c654017b2',               // dropdown
  OTHER_EDUCATION: process.env.CF_OTHER_EDUCATION,               // short text
  CLASS_SCHEDULE: process.env.CF_CLASS_SCHEDULE || '90cf8381-4096-4b5c-8d8d-46f679ae7ef0',     // dropdown Yes/No
  COMMITMENT_LEVEL: process.env.CF_COMMITMENT_LEVEL,             // must be provided in .env (no default)
  BACKGROUND_CHECK: process.env.CF_BACKGROUND_CHECK || 'bda2b4d0-d66e-49ef-b315-b8dce562abfd',  // dropdown Yes/No
  HEARD_ABOUT: process.env.CF_HEARD_ABOUT || 'f44b2bb5-0120-40fd-97c6-17ca42c85d32',           // dropdown
  COHORT: process.env.CF_COHORT,
  // Video handling
  DCA_VIDEO: process.env.CF_DCA_VIDEO,                           // (not used anymore — attachment fields are flaky via API)
  DCA_VIDEO_URL: process.env.CF_DCA_VIDEO_URL,                    // Text/Link field to store the uploaded URL (RECOMMENDED)
  PAYMENT_METHOD: process.env.CF_PAYMENT_METHOD,
};
// --- Cohort drop-down option IDs (set in .env) ---
// COHORT_OCT_ID  -> option id for "DTCA-2502 (October)"
// COHORT_JAN_ID  -> option id for "DTCA-2601 (January)"
const COHORT_OPTIONS = {
  october: process.env.COHORT_OCT_ID || null,
  january: process.env.COHORT_JAN_ID || null
};

/** Normalize a cohort label and resolve to an option id */
function resolveCohortOptionId(input = '') {
  const v = String(input).trim().toLowerCase();

  // explicit canonical values
  if (v === 'october') return COHORT_OPTIONS.october;
  if (v === 'january') return COHORT_OPTIONS.january;

  // accept full labels or codes
  if (v.includes('dtca-2502') || v.includes('oct')) return COHORT_OPTIONS.october;
  if (v.includes('dtca-2601') || v.includes('jan')) return COHORT_OPTIONS.january;

  return null;
}
// ---------------------------------------------------------------------------
// Middleware
app.use(cors({ origin: '*', methods: ['POST','GET','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  const t = 7 * 60 * 1000; // 7 minutes
  req.setTimeout(t);
  res.setTimeout(t);
  next();
});
// ---------------------------------------------------------------------------
// Helpers
/** Basic ClickUp API wrapper */
async function resolveTaskId({ taskId, customTaskId }) {
  if (taskId) return taskId;
  if (!customTaskId) return null;
  const url = `https://api.clickup.com/api/v2/task/${encodeURIComponent(customTaskId)}?custom_task_ids=true&team_id=${process.env.CLICKUP_TEAM_ID}`;
  const r = await fetch(url, { headers: { Authorization: process.env.CLICKUP_TOKEN }});
  if (!r.ok) return null;
  const t = await r.json();
  return t?.id || null;
}
async function cu(path, opts = {}) {
  const res = await fetch(`https://api.clickup.com/api/v2${path}`, {
    ...opts,
    headers: {
      Authorization: CLICKUP_TOKEN,
      ...(opts.headers || {})
    }
  });
  return res;
}

/** Format a simple description for the task */
function buildTaskDescription(p) {
  const rows = [];
  if (p.email) rows.push(`- **Email:** ${p.email}`);
  if (p.phone) rows.push(`- **Phone:** ${p.phone}`);
  if (p.location) rows.push(`- **Location:** ${p.location}${p.otherLocation ? ' (' + p.otherLocation + ')' : ''}`);
  if (p.workEligibility) rows.push(`- **Work eligibility:** ${p.workEligibility}`);
  if (p.education) rows.push(`- **Education:** ${p.education}${p.otherEducation ? ' (' + p.otherEducation + ')' : ''}`);
  if (p.heardAbout) rows.push(`- **Heard about us:** ${p.heardAbout}`);
  if (p.classSchedule) rows.push(`- **Class availability:** ${p.classSchedule}`);
  if (p.commitmentLevel) rows.push(`- **Commitment:** ${p.commitmentLevel}`);

  if (p.hasExperience) rows.push(`- **Prior IT experience:** ${p.hasExperience}`);
  if (p.experienceDescription) rows.push(`\n**Experience details**\n${p.experienceDescription}`);
  if (p.certCompleted) rows.push(`\n**Certifications status:** ${p.certCompleted}`);
  if (p.certificationsListed) rows.push(`**Certifications listed:** ${p.certificationsListed}`);

  if (p.engagementText) rows.push(`\n**Engagement requirement ack:** ${p.engagementText}`);
  if (p.additionalComments) rows.push(`\n**Additional comments**\n${p.additionalComments}`);

  return rows.join('\n');
}

// ---------------- Dropdown option warming & mapping -------------------------

/** Cache: fieldId -> [{id,name}, ...] */
const OPTION_CACHE = new Map();

/** Load all custom fields for the list and cache dropdown options */
async function warmDropdowns() {
  OPTION_CACHE.clear();
  try {
    const r = await cu(`/list/${CLICKUP_LIST_ID}/field`);
    const json = await r.json();
    const fields = json?.fields || [];
    fields.forEach(f => {
      if (Array.isArray(f.type_config?.options)) {
        OPTION_CACHE.set(f.id, f.type_config.options.map(o => ({ id: o.id, name: o.name })));
      }
    });
    console.log(`[ClickUp] Loaded dropdown option maps for ${OPTION_CACHE.size} fields`);
  } catch (e) {
    console.warn('[ClickUp] Could not warm dropdown options:', e?.message || e);
  }
}

function optionIdFor(fieldId, raw) {
  if (!fieldId || !raw) return null;
  const opts = OPTION_CACHE.get(fieldId) || [];
  const norm = s => String(s || '')
    .toLowerCase()
    .replace(/&amp;/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const u = norm(raw);
  if (!opts.length) return null;

  // Exact normalized match
  let found = opts.find(o => norm(o.name) === u);
  if (found) return found.id;

  // Contains / contained-in
  found = opts.find(o => {
    const on = norm(o.name);
    return u.includes(on) || on.includes(u);
  });
  if (found) return found.id;

  // Yes/No shorthands
  if (u === 'yes' || u === 'y') {
    found = opts.find(o => norm(o.name) === 'yes');
    if (found) return found.id;
  }
  if (u === 'no' || u === 'n') {
    found = opts.find(o => norm(o.name) === 'no');
    if (found) return found.id;
  }

  // Special mapping for Work Eligibility (3-option dropdown)
  if (fieldId === CF.WORK_ELIGIBILITY) {
    // US citizen/permanent resident
    if (/(^| )(i am )?(a )?(us|u s|u\.s\.) (citizen|permanent resident)/.test(u) || (u.includes('us') && u.includes('permanent resident'))) {
      found = opts.find(o => {
        const on = norm(o.name);
        return on.includes('us') && (on.includes('citizen') || on.includes('permanent resident'));
      });
      if (found) return found.id;
    }
    // Canadian citizen/permanent resident
    if (u.includes('canada') || u.includes('canadian')) {
      found = opts.find(o => {
        const on = norm(o.name);
        return on.includes('canada') || on.includes('canadian');
      });
      if (found) return found.id;
    }
    // None of the above / Not eligible
    if (u.includes('none') || u.includes('not eligible')) {
      found = opts.find(o => {
        const on = norm(o.name);
        return on.includes('not eligible') || on.includes('none');
      });
      if (found) return found.id;
    }
  }

  console.warn(`[map] no dropdown match for field ${fieldId} value "${raw}". Options=`, opts.map(o => o.name));
  return null;
}

// Push a dropdown value by mapping to option ID; if the field has no options (text field variant), fall back to raw.
function pushDropdownOrText(custom_fields, fieldId, raw) {
  if (!fieldId || !raw) return;
  const hasOptions = OPTION_CACHE.has(fieldId);
  const id = optionIdFor(fieldId, raw);
  if (id) {
    custom_fields.push({ id: fieldId, value: id });
  } else if (!hasOptions) {
    custom_fields.push({ id: fieldId, value: raw });
  } else {
    console.warn(`[map] skipped field ${fieldId} for raw="${raw}" (dropdown with no match)`);
  }
}

// ---------------------------------------------------------------------------
// Routes

app.get('/health', (_req, res) => res.type('text/plain').send('ok'));
// Root path so the public URL does not 502 when hitting "/"
app.get('/', (_req, res) => {
  res.status(200).type('text/plain').send('DTCA backend up ✅');
});

// Introspect loaded dropdowns
app.get('/debug/options', (_req, res) => {
  const out = {};
  OPTION_CACHE.forEach((v, k) => (out[k] = v));
  res.json(out);
});

/**
 * Main submit route
 * Accepts multipart/form-data with optional "videoFile"
 */
app.post('/api/apply', upload.single('videoFile'), async (req, res) => {
  try {
    // Warm dropdowns (safe to call; fast & cached)
    await warmDropdowns();

    // Normalize payload (Shopify -> server)
    const p = normalizePayload(req);

    // === Require a video upload ===
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(200).json({
        status: 'validation_error',
        field: 'videoFile',
        message: 'Please upload a short intro video (required).'
      });
    }

   // Build custom_fields
const custom_fields = [];

// Email
if (CF.EMAIL && p.email) custom_fields.push({ id: CF.EMAIL, value: p.email });

// Phone (already normalized to E.164 client-side)
if (CF.PHONE && p.phone) custom_fields.push({ id: CF.PHONE, value: p.phone });

// Location + other
if (CF.LOCATION && p.location) {
  pushDropdownOrText(custom_fields, CF.LOCATION, p.location);
}
if (CF.OTHER_LOCATION && p.otherLocation) {
  custom_fields.push({ id: CF.OTHER_LOCATION, value: p.otherLocation });
}

// Work eligibility
pushDropdownOrText(custom_fields, CF.WORK_ELIGIBILITY, p.workEligibility);

// Reliable computer (Yes/No)
pushDropdownOrText(custom_fields, CF.RELIABLE_COMPUTER, p.reliableComputer);

// Background check (Yes/No)
pushDropdownOrText(custom_fields, CF.BACKGROUND_CHECK, p.backgroundCheck);

/*  -------------------- IMPORTANT CHANGE --------------------
    Experience & Certifications are now description-only.
    We DO NOT push these to custom fields anymore.
    (They’re still included in buildTaskDescription(p).)
---------------------------------------------------------------- */
// if (CF.EXPERIENCE_DESC && p.experienceDescription) {
//   custom_fields.push({ id: CF.EXPERIENCE_DESC, value: p.experienceDescription });
// }
// if (CF.CERT_COMPLETED && p.certCompleted) {
//   pushDropdownOrText(custom_fields, CF.CERT_COMPLETED, p.certCompleted);
// }
// if (CF.CERT_LISTED && p.certificationsListed) {
//   custom_fields.push({ id: CF.CERT_LISTED, value: p.certificationsListed });
// }

// Education + other (leave as-is unless you also want this description-only)
pushDropdownOrText(custom_fields, CF.EDUCATION, p.education);
if (CF.OTHER_EDUCATION && p.otherEducation) {
  custom_fields.push({ id: CF.OTHER_EDUCATION, value: p.otherEducation });
}

// Class availability (Yes/No)
pushDropdownOrText(custom_fields, CF.CLASS_SCHEDULE, p.classSchedule);

// Commitment (Yes/No)
pushDropdownOrText(custom_fields, CF.COMMITMENT_LEVEL, p.commitmentLevel);

// Heard about us
pushDropdownOrText(custom_fields, CF.HEARD_ABOUT, p.heardAbout);

// Engagement requirement ack & comments
if (CF.ENGAGEMENT_REQ && p.engagementText) {
  custom_fields.push({ id: CF.ENGAGEMENT_REQ, value: p.engagementText });
}
if (CF.ADDITIONAL_COMMENTS && p.additionalComments) {
  custom_fields.push({ id: CF.ADDITIONAL_COMMENTS, value: p.additionalComments });
}

    const body = {
      name: p.fullName || `Application ${new Date().toISOString()}`,
      description: buildTaskDescription(p),
      custom_fields
    };

    console.log('Creating ClickUp task with payload:\n', JSON.stringify(body, null, 2));

    const create = await cu(`/list/${CLICKUP_LIST_ID}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const created = await create.json();
    if (!create.ok) {
      console.error('ClickUp create failed:', create.status, created);
      return res.status(200).json({
        status: 'clickup_create_failed',
        err: created || (await create.text()),
        debug: {
          list: CLICKUP_LIST_ID,
          sent_custom_fields: custom_fields.map(f => f.id)
        }
      });
    }

    const taskId = created?.id;

    // Optional video upload + set a URL/Text field with the uploaded URL
    let uploadMsg = null;
    if (taskId && req.file && req.file.buffer?.length) {
      try {
        console.log('uploading file:', {
          name: req.file.originalname,
          size: req.file.size,
          type: req.file.mimetype
        });

        // Build WHATWG/Undici FormData
        const form = new FormData();
        const blob = new Blob([req.file.buffer], {
          type: req.file.mimetype || 'application/octet-stream'
        });
        form.append('attachment', blob, req.file.originalname || 'video.mp4');

        const up = await fetch(
          `https://api.clickup.com/api/v2/task/${taskId}/attachment?custom_task_ids=true&team_id=${process.env.CLICKUP_TEAM_ID}`,
          {
            method: 'POST',
            headers: { Authorization: CLICKUP_TOKEN },
            body: form
          }
        );
        const upJson = await up.json().catch(() => ({}));
        if (!up.ok) {
          uploadMsg = { step: 'upload', status: up.status, body: upJson };
          console.warn('Attachment upload failed', uploadMsg);
        } else {
          const attUrl =
            upJson?.url ||
            upJson?.attachment?.url ||
            (Array.isArray(upJson) && upJson[0]?.url) ||
            null;

          console.log('upload success', {
            attId:
              upJson?.id ||
              upJson?.attachment?.id ||
              (Array.isArray(upJson) && upJson[0]?.id) ||
              null,
            attUrl
          });

          if (attUrl && CF.DCA_VIDEO_URL) {
            const setUrl = await fetch(
              `https://api.clickup.com/api/v2/task/${taskId}/field/${CF.DCA_VIDEO_URL}?custom_task_ids=true&team_id=${process.env.CLICKUP_TEAM_ID}`,
              {
                method: 'POST',
                headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify({ value: attUrl })
              }
            );
            console.log('Set URL field response', setUrl.status, await setUrl.text().catch(()=>''));
          }

          uploadMsg = 'ok';
        }
      } catch (e) {
        uploadMsg = { step: 'exception', err: String(e) };
        console.warn('Attachment upload error', e);
      }
    } else {
      if (!req.file) console.log('no file in request; skipping upload step');
    }

    return res.json({
      status: 'ok',
      taskId,
      customTaskId: created?.custom_id || null,
      taskUrl: created?.url,
      upload: uploadMsg || 'ok'
    });
  } catch (err) {
    console.error('apply error', err);
    return res.status(200).json({ status: 'server_error', detail: String(err) });
  }
});

/**
 * Set Cohort on an existing task (called from the approved/cohort page)
 * Body: {
 *   taskId?: string,         // numeric/internal id
 *   customTaskId?: string,   // custom id (e.g., DTCA-2601) if using custom task IDs
 *   cohort: 'october' | 'january' | full label
 * }
 */
app.post('/api/cohort', async (req, res) => {
  try {
    const { taskId, customTaskId, cohort } = req.body || {};
    if (!cohort) {
      return res.status(400).json({ status: 'error', message: 'cohort is required' });
    }
    if (!CF.COHORT) {
      return res.status(500).json({ status: 'error', message: 'CF_COHORT not configured on server' });
    }

    // Resolve the ClickUp dropdown option id from label/key
    const optionId = resolveCohortOptionId(cohort);
    if (!optionId) {
      return res.status(400).json({
        status: 'error',
        message: 'Unknown cohort value; expected "october" or "january" (or DTCA-2502/DTCA-2601 label).'
      });
    }

    // Decide which id to use based on env
    const useCustom = String(process.env.CLICKUP_CUSTOM_TASK_IDS).toLowerCase() === 'true';
    const idToUse = useCustom ? (customTaskId || taskId) : taskId;
    if (!idToUse) {
      return res.status(400).json({
        status: 'error',
        message: useCustom
          ? 'Missing customTaskId (or taskId fallback) while CLICKUP_CUSTOM_TASK_IDS=true'
          : 'Missing taskId'
      });
    }

    // Build ClickUp endpoint (include custom_task_ids/team_id only when using custom ids)
    const base = `https://api.clickup.com/api/v2/task/${encodeURIComponent(idToUse)}/field/${CF.COHORT}`;
    const qs = (useCustom && process.env.CLICKUP_TEAM_ID)
      ? `?custom_task_ids=true&team_id=${process.env.CLICKUP_TEAM_ID}`
      : '';
    const url = `${base}${qs}`;

    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: optionId })
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('ClickUp cohort update failed', r.status, j);
      return res.status(400).json({ status: 'error', message: 'clickup_update_failed', details: j });
    }

    return res.json({ status: 'ok', idUsed: idToUse, usedCustom: useCustom, cohort, optionId });
  } catch (e) {
    console.error('/api/cohort error', e);
    return res.status(500).json({ status: 'error', message: 'server_error' });
  }
});
/**
 * Set Payment Method on an existing task.
 * Body: {
 *   taskId?: string,         // internal id
 *   customTaskId?: string,   // custom id (if CLICKUP_CUSTOM_TASK_IDS=true)
 *   method: 'pay_in_full' | 'pay_as_you_go' | 'climb_loan'
 * }
 */
/**
 * Set Payment Method on an existing task.
 * Body: {
 *   taskId?: string,         // internal id
 *   customTaskId?: string,   // custom id (if CLICKUP_CUSTOM_TASK_IDS=true)
 *   method: 'pay_in_full' | 'pay_as_you_go' | 'climb_loan'
 * }
 */
app.post('/api/payment-method', express.json(), async (req, res) => {
  try {
    if (!CF.PAYMENT_METHOD) {
      return res.status(500).json({ status: 'error', message: 'CF_PAYMENT_METHOD not configured' });
    }

    const { taskId, customTaskId, method } = req.body || {};
    const resolvedTaskId = await resolveTaskId({ taskId, customTaskId });
    if (!resolvedTaskId && String(process.env.CLICKUP_CUSTOM_TASK_IDS).toLowerCase() !== 'true') {
      return res.status(400).json({ status: 'error', message: 'taskId required (or customTaskId if using custom ids)' });
    }

    // Decide which ID to send (internal vs custom)
    const useCustom = String(process.env.CLICKUP_CUSTOM_TASK_IDS).toLowerCase() === 'true';
    const idToUse = useCustom ? (customTaskId || resolvedTaskId) : resolvedTaskId;
    if (!idToUse) {
      return res.status(400).json({ status: 'error', message: 'could not resolve task id' });
    }

    // Hard-map to the ClickUp dropdown option IDs you provided
    const optionIdMap = {
      pay_in_full:   '203361fe-94f4-4173-96d9-2e7335cc6be7',
      pay_as_you_go: '5f6b1dc7-b5b4-4a30-817b-8e5e5026e3a6',
      climb_loan:    'ff05f2a5-a7c4-42f9-8a48-bb1c6ce1eb2c'
    };

    const optionId = optionIdMap[method];
    if (!optionId) {
      return res.status(400).json({
        status: 'error',
        message: 'Unknown method. Expected pay_in_full | pay_as_you_go | climb_loan'
      });
    }

    // Build endpoint with custom ids if needed
    const base = `https://api.clickup.com/api/v2/task/${encodeURIComponent(idToUse)}/field/${CF.PAYMENT_METHOD}`;
    const qs = (useCustom && process.env.CLICKUP_TEAM_ID)
      ? `?custom_task_ids=true&team_id=${process.env.CLICKUP_TEAM_ID}`
      : '';
    const url = `${base}${qs}`;

    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: process.env.CLICKUP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: optionId })
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('ClickUp payment method update failed', r.status, j);
      return res.status(400).json({ status: 'error', message: 'clickup_update_failed', details: j });
    }

    return res.json({ status: 'ok', method, usedCustom: useCustom, fieldId: CF.PAYMENT_METHOD });
  } catch (e) {
    console.error('/api/payment-method error', e);
    return res.status(500).json({ status: 'error', message: 'server_error' });
  }
});
app.post('/api/guarantee-sign', express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const { taskId, customTaskId, fullName, signedAt, termsText, signaturePng } = req.body || {};
    const resolvedTaskId = await resolveTaskId({ taskId, customTaskId });
    if (!resolvedTaskId) return res.status(400).json({ ok:false, error:'task_not_found' });

    // Decode signature
    const b64 = (signaturePng || '').split(',')[1];
    if (!b64) return res.status(400).json({ ok:false, error:'bad_signature' });
    const sigBuf = Buffer.from(b64, 'base64');

    // Make PDF
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtca-'));
    const fileName = `DCA-Job-Guarantee-${(fullName||'Applicant').replace(/[^\w\- ]+/g,'')}-${Date.now()}.pdf`;
    const pdfPath = path.join(tmpDir, fileName);

    await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const stream = fs.createWriteStream(pdfPath);
      doc.pipe(stream);

      doc.fontSize(18).text('Dion Training — Career Accelerator Job Guarantee', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(10).fillColor('#555')
        .text(`Signed by: ${fullName || 'N/A'}`)
        .text(`Signed at: ${signedAt || new Date().toISOString()}`);
      doc.moveDown();

      doc.fillColor('#000').fontSize(12).text(termsText || '', { width: 500 });

      doc.addPage();
      doc.fontSize(14).text('Signature', { underline: true });
      doc.moveDown(0.5);
      // place signature image
      const imgPath = path.join(tmpDir, 'sig.png');
      fs.writeFileSync(imgPath, sigBuf);
      try { doc.image(imgPath, { fit:[400,120] }); } catch(_) {}
      doc.moveDown(0.5);
      doc.fontSize(12).text(`Name: ${fullName || ''}`);
      doc.text(`Date: ${signedAt ? new Date(signedAt).toLocaleString() : new Date().toLocaleString()}`);

      doc.end();
      stream.on('finish', resolve);
      stream.on('error', reject);
    });

    // Upload to ClickUp as attachment (Web FormData requires a Blob/File)
    const form = new FormData();
    const pdfBuf = fs.readFileSync(pdfPath);
    const pdfBlob = new Blob([pdfBuf], { type: 'application/pdf' });
    form.append('attachment', pdfBlob, fileName);

    const uploadURL = `https://api.clickup.com/api/v2/task/${resolvedTaskId}/attachment`;
    const up = await fetch(uploadURL, {
      method: 'POST',
      headers: { Authorization: process.env.CLICKUP_TOKEN },
      body: form
    });

    const upBody = await up.json().catch(() => ({}));
    if (!up.ok) {
      console.warn('guarantee pdf upload failed', up.status, upBody);
    } else {
      const attId = upBody?.id || upBody?.attachment?.id || (Array.isArray(upBody) && upBody[0]?.id) || null;
      const attUrl = upBody?.url || upBody?.attachment?.url || (Array.isArray(upBody) && upBody[0]?.url) || null;
      console.log('guarantee pdf uploaded', { attId, attUrl });
    }

    // cleanup temp files
    try { fs.unlinkSync(path.join(tmpDir, 'sig.png')); } catch (_) {}
    try { fs.unlinkSync(pdfPath); } catch (_) {}
    try { fs.rmdirSync(tmpDir); } catch (_) {}

    // Optionally set a boolean custom field “Guarantee Signed”
    if (process.env.CF_GUARANTEE_SIGNED) {
      const cfURL = `https://api.clickup.com/api/v2/task/${resolvedTaskId}/field/${process.env.CF_GUARANTEE_SIGNED}`;
      await fetch(cfURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: process.env.CLICKUP_TOKEN
        },
        body: JSON.stringify({ value: true })
      }).catch(()=>{});
    }

    res.json({ ok:true, attachment: upBody });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});
// Friendly default for any unhandled GETs (prevents "Cannot GET /")
app.get('*', (req, res, next) => {
  // Do not swallow API paths or non-GET methods
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/')) return next();
  if (req.path === '/health' || req.path.startsWith('/debug/')) return next();
  return res.status(200).type('text/plain').send('DTCA backend up ✅');
});

// ---------------------------------------------------------------------------
// Error handler: normalize Multer and other errors to friendly JSON
app.use((err, req, res, next) => {
  if (!err) return next();
  if (err.message === 'INVALID_FILETYPE') {
    return res.status(200).json({
      status: 'validation_error',
      field: 'videoFile',
      message: 'File must be a video (e.g., .mp4, .mov).'
    });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(200).json({
      status: 'validation_error',
      field: 'videoFile',
      message: 'Video too large. Maximum size is 300 MB.'
    });
  }
  console.error('Unhandled error:', err);
  return res.status(200).json({ status: 'server_error', detail: String(err) });
});

// ---------------------------------------------------------------------------
// Boot
(async () => {
  await warmDropdowns();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on ${PORT}`);
  });
})();

// ---------------------------------------------------------------------------
// Normalize incoming form fields from Shopify
function normalizePayload(req) {
  const b = req.body || {};
  return {
    fullName: b.fullName && String(b.fullName).trim(),

    email: b.email && String(b.email).trim(),
    phone: b.phone && String(b.phone).trim(),

    location: b.location && String(b.location).trim(),
    otherLocation: b.otherLocation && String(b.otherLocation).trim(),

    workEligibility: b.workEligibility && String(b.workEligibility).trim(),

    reliableComputer: b.reliableComputer && String(b.reliableComputer).trim(),
    backgroundCheck: b.backgroundCheck && String(b.backgroundCheck).trim(),

    hasExperience: b.hasExperience && String(b.hasExperience).trim(),
    experienceDescription: b.experienceDescription && String(b.experienceDescription).trim(),

    certCompleted: b.certCompleted && String(b.certCompleted).trim(),
    certificationsListed: b.certificationsListed && String(b.certificationsListed).trim(),

    education: b.education && String(b.education).trim(),
    otherEducation: b.otherEducation && String(b.otherEducation).trim(),

    classSchedule: b.classSchedule && String(b.classSchedule).trim(),
    commitmentLevel: b.commitmentLevel && String(b.commitmentLevel).trim(),

    heardAbout: b.heardAbout && String(b.heardAbout).trim(),

    engagementText: b.engagementText && String(b.engagementText).trim(),
    additionalComments: b.additionalComments && String(b.additionalComments).trim()
  };
}