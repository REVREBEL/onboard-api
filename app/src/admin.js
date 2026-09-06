import "./styles.css";

const normalizeConfiguredApiBase = (url) => {
  const normalizedPath = url.pathname.replace(/\/$/, "");
  if (!normalizedPath || normalizedPath === "/") {
    url.pathname = "/api";
  }
  return url.toString().replace(/\/$/, "");
};

const resolveApiBase = () => {
  if (window.__API_BASE__) {
    return window.__API_BASE__.replace(/\/$/, "");
  }

  const origin = window.location?.origin;
  const pageHost = window.location?.hostname;
  const configuredApiBase = import.meta.env.VITE_API_BASE;

  if (configuredApiBase) {
    const trimmedApiBase = configuredApiBase.replace(/\/$/, "");
    try {
      const configuredUrl = new URL(trimmedApiBase, origin || undefined);
      const configuredHost = configuredUrl.hostname;
      const isLocalApiHost = ["localhost", "127.0.0.1", "::1"].includes(configuredHost);
      const isLocalPageHost = ["localhost", "127.0.0.1", "::1"].includes(pageHost);

      if (!isLocalApiHost || isLocalPageHost) {
        return normalizeConfiguredApiBase(configuredUrl);
      }
    } catch {
      return trimmedApiBase;
    }
  }

  if (origin && origin !== "null") {
    return `${origin.replace(/\/$/, "")}/api`;
  }

  return "http://127.0.0.1:4010/api";
};

const apiBase = resolveApiBase();

const pageOrigin = window.location?.origin?.replace(/\/$/, "") || "";

const onboardingForm = document.getElementById("onboardingForm");
const createBtn = document.getElementById("createBtn");
const createStatus = document.getElementById("createStatus");
const createResult = document.getElementById("createResult");
const runnerUrlInput = document.getElementById("runnerUrl");
const copyRunnerUrlBtn = document.getElementById("copyRunnerUrl");
const openRunnerUrlLink = document.getElementById("openRunnerUrl");
const createdToken = document.getElementById("createdToken");

const refreshInstancesBtn = document.getElementById("refreshInstances");
const refreshCatalogBtn = document.getElementById("refreshCatalog");
const limitSelect = document.getElementById("limit");
const instancesBody = document.getElementById("instancesBody");
const tableStatus = document.getElementById("tableStatus");
const progressPanel = document.getElementById("progressPanel");
const progressMeta = document.getElementById("progressMeta");
const progressSections = document.getElementById("progressSections");
const surveySelect = document.getElementById("survey_slug");
const themeSelect = document.getElementById("theme");

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const statusClass = (status) => {
  switch (status) {
    case "completed":
      return "status-completed";
    case "in_progress":
      return "status-in-progress";
    default:
      return "status-not-started";
  }
};

const formatDate = (value) => {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleString();
};

const parseApiError = async (response) => {
  const text = await response.text();
  if (!text) return `HTTP ${response.status}`;
  try {
    const payload = JSON.parse(text);
    return payload.error || text;
  } catch {
    return text;
  }
};

const isSurveyThemePayload = (theme) =>
  !!theme && typeof theme === "object" && ("colorPalette" in theme || "isPanelless" in theme || "cssVariables" in theme);

const setCreateStatus = (message, isError = false) => {
  createStatus.textContent = message || "";
  createStatus.classList.toggle("is-error", !!isError);
};

const setTableStatus = (message, isError = false) => {
  tableStatus.textContent = message || "";
  tableStatus.classList.toggle("is-error", !!isError);
};

const setCreateBusy = (busy) => {
  createBtn.disabled = busy;
  createBtn.textContent = busy ? "Creating..." : "Create URL";
};

const getRunnerUrl = (token, fallbackUrl = "") => {
  if (pageOrigin && token) {
    return `${pageOrigin}/runner.html?token=${encodeURIComponent(token)}`;
  }
  return fallbackUrl;
};

const createPayloadFromForm = () => {
  const hotelName = onboardingForm.hotel_name.value.trim();
  if (!hotelName) {
    throw new Error("Hotel Name is required.");
  }
  const expiresInDaysRaw = onboardingForm.expires_in_days.value.trim();
  const expiresInDaysParsed = parseInt(expiresInDaysRaw, 10);
  const selectedSurveySlug = (onboardingForm.survey_slug?.value || "").trim();
  const selectedTheme = (onboardingForm.theme?.value || "").trim();
  const themeOverride = (onboardingForm.theme_override?.value || "").trim();
  const finalTheme = themeOverride || selectedTheme || "revrebel-dark";

  return {
    hotel_name: hotelName,
    location: onboardingForm.location.value.trim() || null,
    pms_system: onboardingForm.pms_system.value.trim() || null,
    crs_system: onboardingForm.crs_system.value.trim() || null,
    sales_catering_system: onboardingForm.sales_catering_system.value.trim() || null,
    rate_shopping_tool: onboardingForm.rate_shopping_tool.value.trim() || null,
    rms_system: onboardingForm.rms_system.value.trim() || null,
    website_cms: onboardingForm.website_cms.value.trim() || null,
    google_drive_folder_id: onboardingForm.google_drive_folder_id.value.trim() || null,
    scope_revenue: onboardingForm.scope_revenue.checked,
    scope_distribution: onboardingForm.scope_distribution.checked,
    scope_digital: onboardingForm.scope_digital.checked,
    scope_social: onboardingForm.scope_social.checked,
    theme: finalTheme,
    survey_slug: selectedSurveySlug || null,
    expires_in_days: Number.isFinite(expiresInDaysParsed) ? expiresInDaysParsed : 90
  };
};

const renderCreateResult = (payload) => {
  const token = payload?.onboarding_instance?.token || "";
  const url = getRunnerUrl(token, payload?.runner_url || "");
  createResult.hidden = false;
  runnerUrlInput.value = url;
  openRunnerUrlLink.href = url;
  openRunnerUrlLink.textContent = "Open";
  createdToken.textContent = token || "-";
};

const createOnboarding = async (event) => {
  event.preventDefault();
  setCreateStatus("");
  setCreateBusy(true);
  createResult.hidden = true;
  try {
    const body = createPayloadFromForm();
    const response = await fetch(`${apiBase}/onboarding`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(await parseApiError(response));
    }
    const payload = await response.json();
    renderCreateResult(payload);
    setCreateStatus("Onboarding link created.");
    await loadInstances();
  } catch (error) {
    setCreateStatus(`Create failed: ${error.message || String(error)}`, true);
  } finally {
    setCreateBusy(false);
  }
};

const renderInstances = (rows) => {
  if (!rows.length) {
    instancesBody.innerHTML = '<tr><td colspan="7">No onboarding instances found.</td></tr>';
    return;
  }

  const html = rows.map((row) => {
    const token = escapeHtml(row.token);
    const hotel = escapeHtml(row.hotel_name || "Unknown Hotel");
    const location = row.location ? ` <span class="location">${escapeHtml(row.location)}</span>` : "";
    const completion = Number(row.completion_percent || 0).toFixed(2);
    const status = escapeHtml(row.status || "not_started");
    const theme = escapeHtml(row.theme || "-");
    const updated = escapeHtml(formatDate(row.updated_at));
    const expires = escapeHtml(formatDate(row.expires_at));
    return `<tr>
      <td><strong>${hotel}</strong>${location}</td>
      <td><span class="status-pill ${statusClass(row.status)}">${status}</span></td>
      <td>${completion}%</td>
      <td>${theme}</td>
      <td>${updated}</td>
      <td>${expires}</td>
      <td>
        <div class="actions">
          <button type="button" class="row-action" data-action="copy" data-token="${token}">Copy URL</button>
          <a class="row-link" data-action="open" data-token="${token}" target="_blank" rel="noreferrer">Open</a>
          <button type="button" class="row-action" data-action="sync" data-token="${token}">Sync</button>
          <button type="button" class="row-action" data-action="progress" data-token="${token}">Progress</button>
          <button type="button" class="row-action is-danger" data-action="delete" data-token="${token}" data-hotel="${hotel}">Delete</button>
        </div>
      </td>
    </tr>`;
  }).join("");

  instancesBody.innerHTML = html;

  instancesBody.querySelectorAll('a[data-action="open"]').forEach((anchor) => {
    const token = anchor.getAttribute("data-token") || "";
    anchor.href = getRunnerUrl(token);
  });
};

const loadInstances = async () => {
  const limit = parseInt(limitSelect.value, 10) || 50;
  setTableStatus("Loading...");
  refreshInstancesBtn.disabled = true;
  try {
    const response = await fetch(`${apiBase}/onboarding/admin/instances?limit=${limit}`);
    if (!response.ok) throw new Error(await parseApiError(response));
    const rows = await response.json();
    renderInstances(Array.isArray(rows) ? rows : []);
    setTableStatus(`Loaded ${Array.isArray(rows) ? rows.length : 0} rows.`);
  } catch (error) {
    instancesBody.innerHTML = '<tr><td colspan="7">Failed to load data.</td></tr>';
    setTableStatus(`Load failed: ${error.message || String(error)}`, true);
  } finally {
    refreshInstancesBtn.disabled = false;
  }
};

const rebuildSelectOptions = (select, rows, { getValue, getLabel, firstValue, firstLabel }) => {
  if (!select) return;
  const current = select.value;
  select.innerHTML = "";
  const first = document.createElement("option");
  first.value = firstValue;
  first.textContent = firstLabel;
  select.appendChild(first);
  rows.forEach((row) => {
    const value = getValue(row);
    if (!value || value === firstValue) return;
    const option = document.createElement("option");
    option.value = value;
    option.textContent = getLabel(row);
    select.appendChild(option);
  });
  if ([...select.options].some((option) => option.value === current)) {
    select.value = current;
  } else {
    select.value = firstValue;
  }
};

const loadCatalogs = async () => {
  if (refreshCatalogBtn) refreshCatalogBtn.disabled = true;
  try {
    const [surveysResponse, themesResponse] = await Promise.all([
      fetch(`${apiBase}/surveys?limit=200`),
      fetch(`${apiBase}/themes`)
    ]);

    if (!surveysResponse.ok) throw new Error(await parseApiError(surveysResponse));
    if (!themesResponse.ok) throw new Error(await parseApiError(themesResponse));

    const surveys = await surveysResponse.json();
    const themes = await themesResponse.json();

    rebuildSelectOptions(surveySelect, Array.isArray(surveys) ? surveys : [], {
      getValue: (row) => row.slug,
      getLabel: (row) => `${row.title || row.slug} (${row.slug})`,
      firstValue: "",
      firstLabel: "Compose from scope modules (default)"
    });

    const themeNames = [...new Set(
      (Array.isArray(themes) ? themes : [])
        .map((row) => row?.name)
        .filter(Boolean)
    )];
    const themeDetails = await Promise.all(themeNames.map(async (name) => {
      try {
        const response = await fetch(`${apiBase}/themes?name=${encodeURIComponent(name)}`);
        if (!response.ok) return null;
        return await response.json();
      } catch {
        return null;
      }
    }));
    const uniqueThemeNames = themeDetails
      .filter((row) => row && (row.theme?.kind === "survey" || isSurveyThemePayload(row.theme?.theme) || isSurveyThemePayload(row.theme)))
      .map((row) => row.name);

    rebuildSelectOptions(themeSelect, uniqueThemeNames, {
      getValue: (name) => name,
      getLabel: (name) => name,
      firstValue: "revrebel-dark",
      firstLabel: "revrebel-dark"
    });

    setCreateStatus("Catalog refreshed.");
  } catch (error) {
    setCreateStatus(`Catalog load failed: ${error.message || String(error)}`, true);
  } finally {
    if (refreshCatalogBtn) refreshCatalogBtn.disabled = false;
  }
};

const loadProgressForToken = async (token) => {
  progressPanel.hidden = false;
  progressPanel.dataset.token = token;
  progressMeta.textContent = "Loading progress...";
  progressSections.innerHTML = "";
  try {
    const response = await fetch(`${apiBase}/onboarding/${encodeURIComponent(token)}/progress`);
    if (!response.ok) throw new Error(await parseApiError(response));
    const payload = await response.json();
    const completion = Number(payload.completion_percent || 0).toFixed(2);
    progressMeta.textContent = `Token ${token.slice(0, 8)}... | ${payload.status || "unknown"} | ${completion}% | Last saved: ${formatDate(payload.last_saved_at)}`;
    const sections = Array.isArray(payload.sections) ? payload.sections : [];
    if (!sections.length) {
      progressSections.innerHTML = "<li>No section breakdown available.</li>";
      return;
    }
    progressSections.innerHTML = sections
      .map((section) => `<li>${escapeHtml(section.name || "Section")}: ${Number(section.percent || 0).toFixed(2)}%</li>`)
      .join("");
  } catch (error) {
    progressMeta.textContent = `Failed to load progress: ${error.message || String(error)}`;
  }
};

const copyText = async (value) => {
  await navigator.clipboard.writeText(value);
};

if (onboardingForm) {
  onboardingForm.addEventListener("submit", createOnboarding);
}

if (refreshInstancesBtn) {
  refreshInstancesBtn.addEventListener("click", loadInstances);
}

if (refreshCatalogBtn) {
  refreshCatalogBtn.addEventListener("click", loadCatalogs);
}

if (limitSelect) {
  limitSelect.addEventListener("change", loadInstances);
}

if (copyRunnerUrlBtn) {
  copyRunnerUrlBtn.addEventListener("click", async () => {
    if (!runnerUrlInput.value) return;
    try {
      await copyText(runnerUrlInput.value);
      setCreateStatus("Runner URL copied.");
    } catch {
      setCreateStatus("Copy failed.", true);
    }
  });
}

if (instancesBody) {
  instancesBody.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.getAttribute("data-action");
    const token = target.getAttribute("data-token") || "";
    if (!action || !token) return;

    if (action === "copy") {
      try {
        await copyText(getRunnerUrl(token));
        setTableStatus("Runner URL copied.");
      } catch {
        setTableStatus("Copy failed.", true);
      }
      return;
    }

    if (action === "progress") {
      loadProgressForToken(token);
      return;
    }

    if (action === "sync") {
      target.setAttribute("disabled", "disabled");
      const previousLabel = target.textContent;
      target.textContent = "Syncing...";
      try {
        const selectedSyncSourceSlug = (surveySelect?.value || "").trim();
        const syncRequestBody = selectedSyncSourceSlug
          ? { source_survey_slug: selectedSyncSourceSlug }
          : {};
        const response = await fetch(`${apiBase}/onboarding/admin/instances/${encodeURIComponent(token)}/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(syncRequestBody)
        });
        if (!response.ok) throw new Error(await parseApiError(response));
        const payload = await response.json();
        const source = payload?.sync_source === "template" ? "template" : "scope modules";
        const sourceSlug = payload?.source_survey_slug ? ` (${payload.source_survey_slug})` : "";
        setTableStatus(`Instance synced from ${source}${sourceSlug}.`);
        if (progressPanel?.dataset?.token === token) {
          await loadProgressForToken(token);
        }
        await loadInstances();
      } catch (error) {
        setTableStatus(`Sync failed: ${error.message || String(error)}`, true);
      } finally {
        target.removeAttribute("disabled");
        target.textContent = previousLabel || "Sync";
      }
      return;
    }

    if (action === "delete") {
      const hotel = target.getAttribute("data-hotel") || "this client";
      const confirmed = window.confirm(`Delete ${hotel} and all of its onboarding records? This cannot be undone.`);
      if (!confirmed) return;

      target.setAttribute("disabled", "disabled");
      const previousLabel = target.textContent;
      target.textContent = "Deleting...";
      try {
        const response = await fetch(`${apiBase}/onboarding/admin/instances/${encodeURIComponent(token)}`, {
          method: "DELETE"
        });
        if (!response.ok) throw new Error(await parseApiError(response));

        if (progressPanel?.dataset?.token === token) {
          progressPanel.hidden = true;
          progressPanel.dataset.token = "";
          progressMeta.textContent = "";
          progressSections.innerHTML = "";
        }
        setTableStatus("Client and associated onboarding records deleted.");
        await loadInstances();
      } catch (error) {
        setTableStatus(`Delete failed: ${error.message || String(error)}`, true);
      } finally {
        target.removeAttribute("disabled");
        target.textContent = previousLabel || "Delete";
      }
    }
  });
}

loadInstances();
loadCatalogs();
