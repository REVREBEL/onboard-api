import "dotenv/config";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { google } from "googleapis";
import { pool } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const surveyModulesDir = path.resolve(__dirname, "../survey_modules");

const MODULE_FILES = {
  revenue: "revenue.json",
  distribution: "distribution.json",
  digital: "digital.json",
  social: "social.json"
};

const ALWAYS_INCLUDE_SCOPES = new Set(["all", "default"]);

const PMS_INSTRUCTION = {
  opera: "Opera-specific setup note: include your active Opera interfaces and daily export workflow details.",
  stayntouch: "StayNTouch-specific setup note: include active integrations and PMS permission roles used by your team."
};

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 20 } });

app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: true }));
app.use(express.json({ limit: "10mb" }));
app.use(morgan("combined"));
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const onboardingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api/onboarding", onboardingLimiter);

const defaultGoogleDriveFolderId = process.env.DEFAULT_GOOGLE_DRIVE_FOLDER_ID || "";

const ensureRuntimeSchema = async () => {
  await pool.query(`
    ALTER TABLE surveyjs.clients
    ADD COLUMN IF NOT EXISTS sales_catering_system TEXT
  `);

  await pool.query(`
    ALTER TABLE surveyjs.clients
    ADD COLUMN IF NOT EXISTS website_cms TEXT
  `);

  await pool.query(`
    ALTER TABLE surveyjs.onboarding_instances
    ADD COLUMN IF NOT EXISTS source_survey_slug TEXT
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_onboarding_instances_source_survey_slug
    ON surveyjs.onboarding_instances(source_survey_slug)
  `);
};

const safeBool = (value, fallback = false) => (typeof value === "boolean" ? value : fallback);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const slugify = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "client";

const toToken = () => crypto.randomBytes(24).toString("base64url");

const nowUtc = () => new Date();

const addDays = (date, days) => {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};

const buildRunnerUrl = (req, token) => `${req.protocol}://${req.get("host")}/runner.html?token=${encodeURIComponent(token)}`;

const readJsonFile = async (filePath) => {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
};

const loadModuleByKey = async (key) => {
  const fileName = MODULE_FILES[key];
  if (!fileName) return { pages: [] };

  const fullPath = path.join(surveyModulesDir, fileName);

  try {
    return await readJsonFile(fullPath);
  } catch (error) {
    console.warn(`[Survey Compose] Failed to load module ${key}:`, error.message);
    return { pages: [] };
  }
};

const allowedScopes = new Set([...Object.keys(MODULE_FILES), ...ALWAYS_INCLUDE_SCOPES]);

const normalizeScopeValues = (rawScope) => {
  const rawValues = Array.isArray(rawScope)
    ? rawScope
    : typeof rawScope === "string"
      ? rawScope.split(/[,\s|]+/)
      : [];

  return [...new Set(
    rawValues
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => allowedScopes.has(value))
  )];
};

const scopeMatches = (scopeValues, activeScopes) => {
  if (!scopeValues.length) return true;
  if (scopeValues.some((scope) => ALWAYS_INCLUDE_SCOPES.has(scope))) return true;
  return scopeValues.some((scope) => activeScopes.has(scope));
};

const filterSurveyElementsByScope = (elements, activeScopes, inheritedScopes = []) => {
  if (!Array.isArray(elements)) return [];

  const filtered = [];

  for (const element of elements) {
    if (!element || typeof element !== "object") continue;

    const ownScopes = normalizeScopeValues(element.scope);
    const effectiveScopes = ownScopes.length ? ownScopes : inheritedScopes;
    const includeSelf = scopeMatches(effectiveScopes, activeScopes);
    let childMatched = false;

    const next = { ...element };

    if (Array.isArray(element.elements)) {
      const childElements = filterSurveyElementsByScope(element.elements, activeScopes, effectiveScopes);
      next.elements = childElements;
      childMatched = childMatched || childElements.length > 0;
    }

    if (Array.isArray(element.templateElements)) {
      const childTemplateElements = filterSurveyElementsByScope(element.templateElements, activeScopes, effectiveScopes);
      next.templateElements = childTemplateElements;
      childMatched = childMatched || childTemplateElements.length > 0;
    }

    if (Array.isArray(element.rows)) {
      const filteredRows = [];

      for (const row of element.rows) {
        if (!row || typeof row !== "object") continue;

        if (!Array.isArray(row.elements)) {
          if (includeSelf) filteredRows.push({ ...row });
          continue;
        }

        const rowElements = filterSurveyElementsByScope(row.elements, activeScopes, effectiveScopes);

        if (rowElements.length || includeSelf) {
          filteredRows.push({ ...row, elements: rowElements });
        }

        childMatched = childMatched || rowElements.length > 0;
      }

      next.rows = filteredRows;
    }

    if (includeSelf || childMatched) {
      filtered.push(next);
    }
  }

  return filtered;
};

const filterSurveyPagesByScope = (pages, activeScopes) => {
  if (!Array.isArray(pages)) return [];

  const filteredPages = [];

  for (const page of pages) {
    if (!page || typeof page !== "object") continue;

    const pageScopes = normalizeScopeValues(page.scope);
    const includePage = scopeMatches(pageScopes, activeScopes);
    const filteredElements = filterSurveyElementsByScope(page.elements, activeScopes, pageScopes);
    const hasElements = filteredElements.length > 0;
    const hadElementArray = Array.isArray(page.elements);

    if (!includePage && !hasElements) continue;
    if (hadElementArray && !hasElements) continue;

    filteredPages.push({ ...page, elements: filteredElements });
  }

  return filteredPages;
};

const deriveActiveScopes = ({ scope_revenue, scope_distribution, scope_digital, scope_social }) => {
  const scopeMap = [
    ["revenue", scope_revenue],
    ["distribution", scope_distribution],
    ["digital", scope_digital],
    ["social", scope_social]
  ];

  const activeModules = scopeMap.filter(([, enabled]) => !!enabled).map(([key]) => key);
  return new Set(activeModules.length ? activeModules : ["revenue"]);
};

const ensureSurveyPages = (pages) => {
  if (Array.isArray(pages) && pages.length > 0) return pages;

  return [
    {
      name: "general_onboarding",
      title: "General Onboarding",
      elements: [
        {
          type: "comment",
          name: "general_notes",
          title: "Share any onboarding details we should know.",
          isRequired: true
        }
      ]
    }
  ];
};

const applyPmsInstruction = (pages, pms_system) => {
  const nextPages = Array.isArray(pages) ? pages : [];
  if (!nextPages.length) return nextPages;

  const pmsKey = String(pms_system || "").toLowerCase().replace(/\s+/g, "");
  const pmsInstruction = PMS_INSTRUCTION[pmsKey];

  if (!pmsInstruction) return nextPages;

  nextPages[0].elements = Array.isArray(nextPages[0].elements) ? nextPages[0].elements : [];
  nextPages[0].elements.unshift({
    type: "html",
    name: "pms_instruction",
    html: `<div><strong>PMS guidance:</strong> ${pmsInstruction}</div>`
  });

  return nextPages;
};

const applyWebsiteCmsAccessLogic = (pages) => {
  const walkElements = (elements) => {
    if (!Array.isArray(elements)) return;

    elements.forEach((element) => {
      if (!element || typeof element !== "object") return;

      if (element.name === "webflow_access") {
        element.visibleIf = "{website_cms} = 'Webflow'";
      }

      if (element.name === "website_cms_access") {
        element.visibleIf = "{website_cms} <> 'Webflow'";
      }

      walkElements(element.elements);
      walkElements(element.templateElements);

      if (Array.isArray(element.rows)) {
        element.rows.forEach((row) => walkElements(row?.elements));
      }
    });
  };

  const nextPages = Array.isArray(pages) ? pages : [];
  nextPages.forEach((page) => walkElements(page?.elements));
  return nextPages;
};

const applyDriveUploadConfig = (pages) => {
  const walkElements = (elements) => {
    if (!Array.isArray(elements)) return;

    elements.forEach((element) => {
      if (!element || typeof element !== "object") return;

      if (String(element.type || "").toLowerCase() === "file") {
        element.storeDataAsText = false;
        element.waitForUpload = true;
        if (element.allowMultiple === undefined) {
          element.allowMultiple = true;
        }
      }

      walkElements(element.elements);
      walkElements(element.templateElements);

      if (Array.isArray(element.rows)) {
        element.rows.forEach((row) => walkElements(row?.elements));
      }
    });
  };

  const nextPages = Array.isArray(pages) ? pages : [];
  nextPages.forEach((page) => walkElements(page?.elements));
  return nextPages;
};

const composeSurveyJson = async ({
  hotel_name,
  pms_system,
  scope_revenue,
  scope_distribution,
  scope_digital,
  scope_social
}) => {
  const activeScopes = deriveActiveScopes({
    scope_revenue,
    scope_distribution,
    scope_digital,
    scope_social
  });

  const modules = await Promise.all([...activeScopes].map((key) => loadModuleByKey(key)));
  const rawPages = modules.flatMap((mod) => (Array.isArray(mod.pages) ? mod.pages : []));
  const pages = applyDriveUploadConfig(applyWebsiteCmsAccessLogic(applyPmsInstruction(
    ensureSurveyPages(filterSurveyPagesByScope(rawPages, activeScopes)),
    pms_system
  )));

  return {
    title: `REVREBEL Onboarding - ${hotel_name || "Client"}`,
    showProgressBar: "top",
    showQuestionNumbers: "off",
    pages
  };
};

const buildScopedSurveyFromTemplate = ({
  sourceSurvey,
  hotel_name,
  pms_system,
  scope_revenue,
  scope_distribution,
  scope_digital,
  scope_social
}) => {
  const sourceSurveyJson = sourceSurvey?.json_schema && typeof sourceSurvey.json_schema === "object"
    ? sourceSurvey.json_schema
    : {};

  const activeScopes = deriveActiveScopes({
    scope_revenue,
    scope_distribution,
    scope_digital,
    scope_social
  });

  const scopedPages = filterSurveyPagesByScope(sourceSurveyJson.pages, activeScopes);
  const finalPages = applyDriveUploadConfig(applyWebsiteCmsAccessLogic(applyPmsInstruction(ensureSurveyPages(scopedPages), pms_system)));

  const sourceMeta = sourceSurveyJson.__meta && typeof sourceSurveyJson.__meta === "object"
    ? sourceSurveyJson.__meta
    : {};

  return {
    ...sourceSurveyJson,
    title: sourceSurveyJson.title || sourceSurvey.title || `REVREBEL Onboarding - ${hotel_name || "Client"}`,
    showProgressBar: sourceSurveyJson.showProgressBar || "top",
    showQuestionNumbers: sourceSurveyJson.showQuestionNumbers || "off",
    pages: finalPages,
    __meta: {
      ...sourceMeta,
      source_survey_slug: sourceSurvey.slug,
      compose_mode: "template"
    }
  };
};

const getQuestionList = (surveyJson) => {
  const pages = Array.isArray(surveyJson?.pages) ? surveyJson.pages : [];
  const questions = [];

  const walkElements = (elements, pageName) => {
    if (!Array.isArray(elements)) return;

    for (const element of elements) {
      if (!element || typeof element !== "object") continue;

      if (element.name) {
        questions.push({
          name: element.name,
          isRequired: !!element.isRequired,
          pageName
        });
      }

      if (Array.isArray(element.elements)) walkElements(element.elements, pageName);
      if (Array.isArray(element.templateElements)) walkElements(element.templateElements, pageName);

      if (Array.isArray(element.rows)) {
        for (const row of element.rows) {
          walkElements(row?.elements, pageName);
        }
      }
    }
  };

  for (const page of pages) {
    walkElements(page?.elements, page?.name || "page");
  }

  return questions;
};

const hasAnswer = (value) => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
};

const calculateProgress = (surveyJson, responseData) => {
  const answers = responseData && typeof responseData === "object" ? responseData : {};
  const questions = getQuestionList(surveyJson);
  const required = questions.filter((q) => q.isRequired);
  const requiredCount = required.length;

  if (!requiredCount) {
    return { completion_percent: 0, sections: [] };
  }

  let answeredRequired = 0;
  const byPage = new Map();

  for (const q of required) {
    const pageStats = byPage.get(q.pageName) || { total: 0, answered: 0 };
    pageStats.total += 1;

    if (hasAnswer(answers[q.name])) {
      answeredRequired += 1;
      pageStats.answered += 1;
    }

    byPage.set(q.pageName, pageStats);
  }

  const sections = [...byPage.entries()].map(([name, stats]) => ({
    name,
    percent: stats.total ? Number(((stats.answered / stats.total) * 100).toFixed(2)) : 0
  }));

  return {
    completion_percent: Number(((answeredRequired / requiredCount) * 100).toFixed(2)),
    sections
  };
};

const onboardingByTokenQuery = `
  SELECT
    oi.*,
    c.hotel_name,
    c.location,
    c.pms_system,
    c.crs_system,
    c.sales_catering_system,
    c.rate_shopping_tool,
    c.rms_system,
    c.website_cms,
    c.google_drive_folder_id,
    s.json_schema
  FROM surveyjs.onboarding_instances oi
  JOIN surveyjs.clients c ON c.id = oi.client_id
  JOIN surveyjs.surveys s ON s.slug = oi.survey_slug
  WHERE oi.token = $1
`;

const getOnboardingByToken = async (token) => {
  const { rows } = await pool.query(onboardingByTokenQuery, [token]);
  return rows[0] || null;
};

const assertActiveOnboarding = (record) => {
  if (!record) return { ok: false, status: 404, error: "invalid token" };
  if (record.revoked_at) return { ok: false, status: 403, error: "token revoked" };

  if (record.expires_at && new Date(record.expires_at) < nowUtc()) {
    return { ok: false, status: 410, error: "token expired" };
  }

  return { ok: true };
};

let googleDriveClient = null;

const getGoogleDriveClient = async () => {
  if (googleDriveClient) return googleDriveClient;

  const scopes = ["https://www.googleapis.com/auth/drive.file"];
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const serviceAccountBase64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  let credentials = null;

  if (serviceAccountJson) {
    credentials = JSON.parse(serviceAccountJson);
  } else if (serviceAccountBase64) {
    credentials = JSON.parse(Buffer.from(serviceAccountBase64, "base64").toString("utf8"));
  }

  const auth = new google.auth.GoogleAuth({
    scopes,
    credentials: credentials || undefined,
    keyFile: credentials ? undefined : process.env.GOOGLE_APPLICATION_CREDENTIALS
  });

  googleDriveClient = google.drive({ version: "v3", auth });
  return googleDriveClient;
};

const uploadFileToDrive = async (drive, folderId, file) => {
  const media = {
    mimeType: file.mimetype || "application/octet-stream",
    body: Readable.from(file.buffer)
  };

  const requestBody = {
    name: file.originalname,
    parents: [folderId]
  };

  const { data } = await drive.files.create({
    requestBody,
    media,
    supportsAllDrives: true,
    fields: "id,name,mimeType,size,webViewLink,webContentLink"
  });

  return data;
};

/**
 * Health check
 */
app.get("/api/health", (req, res) => res.json({ ok: true }));

/**
 * List surveys (slug + metadata)
 */
app.get("/api/surveys", async (req, res) => {
  const limitParam = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 100;

  try {
    const { rows } = await pool.query(
      `SELECT slug, title, version, created_at, updated_at
       FROM surveyjs.surveys
       ORDER BY updated_at DESC
       LIMIT $1`,
      [limit]
    );

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Upsert a survey (create or update by slug)
 * body: { slug, title, json_schema, version? }
 */
app.post("/api/surveys", async (req, res) => {
  const { slug, title, json_schema, version = 1 } = req.body || {};

  if (!slug || !title || !json_schema) {
    return res.status(400).json({ error: "slug, title, json_schema required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO surveyjs.surveys (slug, title, json_schema, version)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (slug)
       DO UPDATE SET title = EXCLUDED.title, json_schema = EXCLUDED.json_schema, version = EXCLUDED.version, updated_at = now()
       RETURNING *`,
      [slug, title, json_schema, version]
    );

    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Get a survey by slug
 */
app.get("/api/surveys/:slug", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM surveyjs.surveys WHERE slug = $1",
      [req.params.slug]
    );

    if (!rows.length) return res.status(404).json({ error: "not found" });

    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Delete a survey by slug
 */
app.delete("/api/surveys/:slug", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "DELETE FROM surveyjs.surveys WHERE slug = $1 RETURNING slug, title",
      [req.params.slug]
    );

    if (!rows.length) return res.status(404).json({ error: "not found" });

    res.json({ deleted: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Record a response
 * body: { survey_slug, response_data, meta? }
 */
app.post("/api/responses", async (req, res) => {
  const { survey_slug, response_data, meta } = req.body || {};

  if (!survey_slug || !response_data) {
    return res.status(400).json({ error: "survey_slug and response_data required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO surveyjs.responses (survey_slug, response_data, meta)
       VALUES ($1, $2::jsonb, $3::jsonb)
       RETURNING *`,
      [survey_slug, response_data, meta || null]
    );

    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Upsert Creator UI theme
 */
app.post("/api/themes", async (req, res) => {
  const { name, theme } = req.body || {};

  if (!name || !theme) {
    return res.status(400).json({ error: "name and theme required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO surveyjs.creator_themes (name, theme, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (name) DO UPDATE SET theme = EXCLUDED.theme, updated_at = now()
       RETURNING *`,
      [name, theme]
    );

    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * List or fetch Creator UI themes
 */
app.get("/api/themes", async (req, res) => {
  const name = req.query.name;

  try {
    if (name) {
      const { rows } = await pool.query(
        "SELECT * FROM surveyjs.creator_themes WHERE name = $1",
        [name]
      );

      if (!rows.length) return res.status(404).json({ error: "not found" });

      return res.json(rows[0]);
    }

    const { rows } = await pool.query(
      "SELECT name, created_at, updated_at FROM surveyjs.creator_themes ORDER BY updated_at DESC"
    );

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Delete a Creator/Survey theme by name
 */
app.delete("/api/themes/:name", async (req, res) => {
  const { name } = req.params;

  if (!name) {
    return res.status(400).json({ error: "name required" });
  }

  try {
    const { rowCount } = await pool.query(
      "DELETE FROM surveyjs.creator_themes WHERE name = $1",
      [name]
    );

    if (!rowCount) return res.status(404).json({ error: "not found" });

    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Create onboarding instance + token URL
 */
app.post("/api/onboarding", async (req, res) => {
  const {
    hotel_name,
    location,
    pms_system,
    crs_system,
    sales_catering_system,
    rate_shopping_tool,
    rms_system,
    website_cms,
    google_drive_folder_id,
    survey_slug,
    scope_revenue = false,
    scope_distribution = false,
    scope_digital = false,
    scope_social = false,
    theme = "revrebel-dark",
    expires_in_days = 90
  } = req.body || {};

  if (!hotel_name) {
    return res.status(400).json({ error: "hotel_name required" });
  }

  const scope = {
    scope_revenue: safeBool(scope_revenue),
    scope_distribution: safeBool(scope_distribution),
    scope_digital: safeBool(scope_digital),
    scope_social: safeBool(scope_social)
  };

  const expiresDays = clamp(parseInt(expires_in_days, 10) || 90, 1, 365);
  const createdAt = nowUtc();
  const expiresAt = addDays(createdAt, expiresDays);
  const token = toToken();
  const requestedSurveySlug = typeof survey_slug === "string" ? survey_slug.trim() : "";
  const generatedSurveySlug = `onboarding-${slugify(hotel_name)}-${Date.now().toString(36)}`;
  const sourceSurveySlug = requestedSurveySlug || null;

  try {
    const resolvedGoogleDriveFolderId = google_drive_folder_id || defaultGoogleDriveFolderId || null;
    let onboardingSurveyJson = null;
    let onboardingSurveyTitle = `REVREBEL Onboarding - ${hotel_name}`;

    const clientInsert = await pool.query(
      `INSERT INTO surveyjs.clients
       (hotel_name, location, pms_system, crs_system, sales_catering_system, rate_shopping_tool, rms_system, website_cms, google_drive_folder_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        hotel_name,
        location || null,
        pms_system || null,
        crs_system || null,
        sales_catering_system || null,
        rate_shopping_tool || null,
        rms_system || null,
        website_cms || null,
        resolvedGoogleDriveFolderId
      ]
    );

    const client = clientInsert.rows[0];

    if (requestedSurveySlug) {
      const existingSurvey = await pool.query(
        "SELECT slug, title, json_schema FROM surveyjs.surveys WHERE slug = $1",
        [requestedSurveySlug]
      );

      if (!existingSurvey.rows.length) {
        return res.status(400).json({ error: `survey_slug not found: ${requestedSurveySlug}` });
      }

      const selectedSurvey = existingSurvey.rows[0];

      onboardingSurveyJson = buildScopedSurveyFromTemplate({
        sourceSurvey: selectedSurvey,
        hotel_name,
        pms_system,
        ...scope
      });

      onboardingSurveyTitle = selectedSurvey.title || onboardingSurveyTitle;
    } else {
      onboardingSurveyJson = await composeSurveyJson({
        hotel_name,
        pms_system,
        ...scope
      });

      const composeMeta = onboardingSurveyJson.__meta && typeof onboardingSurveyJson.__meta === "object"
        ? onboardingSurveyJson.__meta
        : {};

      onboardingSurveyJson.__meta = {
        ...composeMeta,
        compose_mode: "modules"
      };
    }

    await pool.query(
      `INSERT INTO surveyjs.surveys (slug, title, json_schema, version)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [generatedSurveySlug, onboardingSurveyTitle, onboardingSurveyJson, 1]
    );

    const onboardingInsert = await pool.query(
      `INSERT INTO surveyjs.onboarding_instances
       (client_id, survey_slug, source_survey_slug, token, scope_revenue, scope_distribution, scope_digital, scope_social, theme, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'not_started', $10)
       RETURNING *`,
      [
        client.id,
        generatedSurveySlug,
        sourceSurveySlug,
        token,
        scope.scope_revenue,
        scope.scope_distribution,
        scope.scope_digital,
        scope.scope_social,
        theme,
        expiresAt
      ]
    );

    const onboarding = onboardingInsert.rows[0];

    res.status(201).json({
      client,
      onboarding_instance: onboarding,
      runner_url: buildRunnerUrl(req, token)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Load onboarding payload by token
 */
app.get("/api/onboarding/:token", async (req, res) => {
  try {
    const record = await getOnboardingByToken(req.params.token);
    const state = assertActiveOnboarding(record);

    if (!state.ok) return res.status(state.status).json({ error: state.error });

    const folderId = record.google_drive_folder_id || null;
    const folderUrl = folderId ? `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}` : null;

    res.json({
      token: record.token,
      status: record.status,
      theme: record.theme,
      scope: {
        revenue: record.scope_revenue,
        distribution: record.scope_distribution,
        digital: record.scope_digital,
        social: record.scope_social
      },
      source_survey_slug: record.source_survey_slug || null,
      survey_slug: record.survey_slug,
      survey_json: record.json_schema,
      client: {
        hotel_name: record.hotel_name,
        location: record.location,
        pms_system: record.pms_system,
        crs_system: record.crs_system,
        sales_catering_system: record.sales_catering_system,
        rate_shopping_tool: record.rate_shopping_tool,
        rms_system: record.rms_system,
        website_cms: record.website_cms,
        google_drive_folder_id: folderId,
        google_drive_folder_url: folderUrl
      },
      draft_data: record.draft_data,
      final_data: record.final_data,
      current_page: record.current_page,
      completion_percent: Number(record.completion_percent || 0),
      last_saved_at: record.last_saved_at,
      expires_at: record.expires_at
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Save onboarding draft (autosave)
 */
app.patch("/api/onboarding/:token/draft", async (req, res) => {
  const { draft_data, current_page = 0, completion_percent } = req.body || {};

  if (!draft_data || typeof draft_data !== "object") {
    return res.status(400).json({ error: "draft_data object required" });
  }

  try {
    const record = await getOnboardingByToken(req.params.token);
    const state = assertActiveOnboarding(record);

    if (!state.ok) return res.status(state.status).json({ error: state.error });

    const computed = calculateProgress(record.json_schema, draft_data);
    const persistedCompletion = Number.isFinite(completion_percent)
      ? clamp(Number(completion_percent), 0, 100)
      : computed.completion_percent;

    const nextStatus = record.status === "completed" ? "completed" : "in_progress";

    const { rows } = await pool.query(
      `UPDATE surveyjs.onboarding_instances
       SET draft_data = $2::jsonb,
           current_page = $3,
           completion_percent = $4,
           status = $5,
           last_saved_at = now(),
           updated_at = now()
       WHERE token = $1
       RETURNING token, status, completion_percent, current_page, last_saved_at, updated_at`,
      [req.params.token, draft_data, Math.max(parseInt(current_page, 10) || 0, 0), persistedCompletion, nextStatus]
    );

    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Complete onboarding and store final response payload
 */
app.post("/api/onboarding/:token/complete", async (req, res) => {
  const { final_data } = req.body || {};

  if (!final_data || typeof final_data !== "object") {
    return res.status(400).json({ error: "final_data object required" });
  }

  try {
    const record = await getOnboardingByToken(req.params.token);
    const state = assertActiveOnboarding(record);

    if (!state.ok) return res.status(state.status).json({ error: state.error });

    const computed = calculateProgress(record.json_schema, final_data);

    const { rows } = await pool.query(
      `UPDATE surveyjs.onboarding_instances
       SET final_data = $2::jsonb,
           status = 'completed',
           completion_percent = $3,
           last_saved_at = now(),
           updated_at = now()
       WHERE token = $1
       RETURNING token, status, completion_percent, last_saved_at, updated_at`,
      [req.params.token, final_data, Math.max(computed.completion_percent, 100)]
    );

    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Onboarding progress details for dashboard
 */
app.get("/api/onboarding/:token/progress", async (req, res) => {
  try {
    const record = await getOnboardingByToken(req.params.token);
    const state = assertActiveOnboarding(record);

    if (!state.ok) return res.status(state.status).json({ error: state.error });

    const source = record.final_data || record.draft_data || {};
    const progress = calculateProgress(record.json_schema, source);
    const completionPercent = Number(record.completion_percent || progress.completion_percent || 0);

    res.json({
      completion_percent: completionPercent,
      sections: progress.sections,
      status: record.status,
      last_saved_at: record.last_saved_at
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Upload onboarding files directly to Google Drive
 */
app.post("/api/onboarding/:token/upload", upload.array("files"), async (req, res) => {
  try {
    const record = await getOnboardingByToken(req.params.token);
    const state = assertActiveOnboarding(record);

    if (!state.ok) return res.status(state.status).json({ error: state.error });

    if (!record.google_drive_folder_id) {
      return res.status(400).json({ error: "google_drive_folder_id is not configured for this client" });
    }

    if (!Array.isArray(req.files) || req.files.length === 0) {
      return res.status(400).json({ error: "at least one file is required" });
    }

    let drive;

    try {
      drive = await getGoogleDriveClient();
    } catch (error) {
      return res.status(501).json({
        error: "Google Drive credentials are not configured",
        details: error.message
      });
    }

    const uploaded = [];

    try {
      for (const file of req.files) {
        const data = await uploadFileToDrive(drive, record.google_drive_folder_id, file);

        uploaded.push({
          name: data.name,
          mimeType: data.mimeType,
          size: data.size,
          content: data.webViewLink || data.webContentLink || "",
          fileId: data.id
        });
      }
    } catch (error) {
      const message = String(error?.message || "");

      if (message.includes("default credentials")) {
        return res.status(501).json({ error: "Google Drive credentials are not configured", details: message });
      }

      throw error;
    }

    res.json({ files: uploaded });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Admin dashboard list endpoint
 */
app.get("/api/onboarding/admin/instances", async (req, res) => {
  const limitParam = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 100;

  try {
    const { rows } = await pool.query(
      `SELECT
          oi.id,
          oi.token,
          oi.status,
          oi.theme,
          oi.source_survey_slug,
          oi.completion_percent,
          oi.last_saved_at,
          oi.created_at,
          oi.updated_at,
          oi.expires_at,
          c.hotel_name,
          c.sales_catering_system,
          c.website_cms,
          c.location
       FROM surveyjs.onboarding_instances oi
       JOIN surveyjs.clients c ON c.id = oi.client_id
       ORDER BY oi.updated_at DESC
       LIMIT $1`,
      [limit]
    );

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Admin sync onboarding snapshot from source template/modules
 */
app.post("/api/onboarding/admin/instances/:token/sync", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
          oi.id,
          oi.token,
          oi.survey_slug,
          oi.scope_revenue,
          oi.scope_distribution,
          oi.scope_digital,
          oi.scope_social,
          oi.source_survey_slug,
          oi.status,
          oi.draft_data,
          oi.final_data,
          oi.completion_percent,
          c.hotel_name,
          c.pms_system,
          c.sales_catering_system,
          c.website_cms,
          s.title AS snapshot_title,
          s.json_schema AS snapshot_json
       FROM surveyjs.onboarding_instances oi
       JOIN surveyjs.clients c ON c.id = oi.client_id
       JOIN surveyjs.surveys s ON s.slug = oi.survey_slug
       WHERE oi.token = $1`,
      [req.params.token]
    );

    const record = rows[0];

    if (!record) return res.status(404).json({ error: "not found" });

    const requestedSourceSlug = typeof req.body?.source_survey_slug === "string"
      ? req.body.source_survey_slug.trim()
      : "";

    const snapshotJson = record.snapshot_json && typeof record.snapshot_json === "object"
      ? record.snapshot_json
      : {};

    const snapshotMeta = snapshotJson.__meta && typeof snapshotJson.__meta === "object"
      ? snapshotJson.__meta
      : {};

    let sourceSurveySlug = requestedSourceSlug
      || String(record.source_survey_slug || "").trim()
      || String(snapshotMeta.source_survey_slug || "").trim();

    let inferredSourceSurveySlug = false;

    if (!sourceSurveySlug && record.snapshot_title) {
      const inferred = await pool.query(
        `SELECT slug
         FROM surveyjs.surveys
         WHERE slug <> $1
           AND slug NOT LIKE 'onboarding-%'
           AND title = $2
         ORDER BY updated_at DESC
         LIMIT 2`,
        [record.survey_slug, record.snapshot_title]
      );

      if (inferred.rows.length === 1) {
        sourceSurveySlug = inferred.rows[0].slug;
        inferredSourceSurveySlug = true;
      }
    }

    let nextSurveyJson;
    let nextSurveyTitle;
    let syncSource;
    let resolvedSourceSurveySlug = null;

    if (sourceSurveySlug) {
      const sourceQuery = await pool.query(
        "SELECT slug, title, json_schema FROM surveyjs.surveys WHERE slug = $1",
        [sourceSurveySlug]
      );

      const sourceSurvey = sourceQuery.rows[0];

      if (!sourceSurvey) {
        return res.status(400).json({
          error: `source survey not found: ${sourceSurveySlug}`
        });
      }

      nextSurveyJson = buildScopedSurveyFromTemplate({
        sourceSurvey,
        hotel_name: record.hotel_name,
        pms_system: record.pms_system,
        scope_revenue: record.scope_revenue,
        scope_distribution: record.scope_distribution,
        scope_digital: record.scope_digital,
        scope_social: record.scope_social
      });

      nextSurveyTitle = sourceSurvey.title || record.snapshot_title || `REVREBEL Onboarding - ${record.hotel_name || "Client"}`;
      syncSource = "template";
      resolvedSourceSurveySlug = sourceSurvey.slug;
    } else {
      nextSurveyJson = await composeSurveyJson({
        hotel_name: record.hotel_name,
        pms_system: record.pms_system,
        scope_revenue: record.scope_revenue,
        scope_distribution: record.scope_distribution,
        scope_digital: record.scope_digital,
        scope_social: record.scope_social
      });

      nextSurveyJson.__meta = {
        ...(nextSurveyJson.__meta && typeof nextSurveyJson.__meta === "object" ? nextSurveyJson.__meta : {}),
        compose_mode: "modules"
      };

      nextSurveyTitle = nextSurveyJson.title || record.snapshot_title || `REVREBEL Onboarding - ${record.hotel_name || "Client"}`;
      syncSource = "modules";
      resolvedSourceSurveySlug = null;
    }

    nextSurveyJson.__meta = {
      ...(nextSurveyJson.__meta && typeof nextSurveyJson.__meta === "object" ? nextSurveyJson.__meta : {}),
      synced_at: new Date().toISOString()
    };

    const sourceData = (record.final_data && typeof record.final_data === "object")
      ? record.final_data
      : (record.draft_data && typeof record.draft_data === "object")
        ? record.draft_data
        : {};

    const progress = calculateProgress(nextSurveyJson, sourceData);
    const nextCompletionPercent = record.status === "completed"
      ? 100
      : clamp(Number(progress.completion_percent || 0), 0, 100);

    const surveyUpdate = await pool.query(
      `UPDATE surveyjs.surveys
       SET title = $2,
           json_schema = $3::jsonb,
           version = version + 1,
           updated_at = now()
       WHERE slug = $1
       RETURNING slug, title, version, updated_at`,
      [record.survey_slug, nextSurveyTitle, nextSurveyJson]
    );

    const onboardingUpdate = await pool.query(
      `UPDATE surveyjs.onboarding_instances
       SET completion_percent = $2,
           source_survey_slug = $3,
           updated_at = now()
       WHERE token = $1
       RETURNING token, status, completion_percent, source_survey_slug, updated_at`,
      [record.token, nextCompletionPercent, resolvedSourceSurveySlug]
    );

    res.json({
      ok: true,
      sync_source: syncSource,
      source_survey_slug: resolvedSourceSurveySlug,
      inferred_source_survey_slug: inferredSourceSurveySlug,
      survey: surveyUpdate.rows[0],
      onboarding_instance: onboardingUpdate.rows[0]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Admin delete client by onboarding token.
 * Deleting the client cascades to all of its onboarding instances.
 */
app.delete("/api/onboarding/admin/instances/:token", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `WITH target_client AS (
         SELECT client_id
         FROM surveyjs.onboarding_instances
         WHERE token = $1
       )
       DELETE FROM surveyjs.clients AS client
       USING target_client
       WHERE client.id = target_client.client_id
       RETURNING client.id, client.hotel_name, client.updated_at`,
      [req.params.token]
    );

    if (!rows.length) return res.status(404).json({ error: "not found" });

    res.json({ deleted: rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

try {
  await ensureRuntimeSchema();
} catch (error) {
  console.error("[Startup] Failed to ensure onboarding runtime schema:", error.message);
}

export default app;
