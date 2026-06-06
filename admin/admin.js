const state = {
  user: null,
  setupRequired: false,
  view: "requests",
  summary: null,
  requests: [],
  selectedRequestId: "",
  pages: [],
  selectedPageKey: "home",
  pageContent: "",
  media: [],
  notifications: null,
  providers: {},
  users: []
};

const viewTitles = {
  requests: ["Contact form", "Requests"],
  editor: ["Public website", "Page Editor"],
  media: ["Assets", "Media"],
  notifications: ["Alerts", "Notifications"],
  users: ["Access", "Accounts"]
};

function $(selector, root = document) {
  return root.querySelector(selector);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatBytes(value) {
  const size = Number(value || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function toast(message) {
  const node = $("[data-toast]");
  node.textContent = message;
  node.hidden = false;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => { node.hidden = true; }, 2800);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    headers: options.body instanceof FormData ? (options.headers || {}) : {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.message || "Request failed.");
  }
  return data;
}

function setAuthMessage(message = "", error = false) {
  const node = $("[data-auth-message]");
  node.textContent = message;
  node.classList.toggle("error", error);
}

function showAuth() {
  $("[data-auth-view]").hidden = false;
  $("[data-dashboard]").hidden = true;
  $("[data-setup-field]").hidden = !state.setupRequired;
  $("[data-auth-subtitle]").textContent = state.setupRequired
    ? "Create the first owner account with the setup code."
    : "Sign in or request access.";
}

function showDashboard() {
  $("[data-auth-view]").hidden = true;
  $("[data-dashboard]").hidden = false;
  $("[data-user-line]").textContent = `${state.user?.name || "Admin"} - ${state.user?.role || "viewer"}`;
  renderView();
}

function toggleAuthTab(tab) {
  const login = tab === "login";
  document.querySelectorAll("[data-auth-tab]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.authTab === tab);
  });
  $("[data-login-fields]").hidden = !login;
  $("[data-register-fields]").hidden = login;
  setAuthMessage("");
}

async function bootstrap() {
  const data = await api("/api/admin/me");
  state.user = data.user || null;
  state.setupRequired = Boolean(data.setupRequired);
  if (!data.authenticated) {
    showAuth();
    return;
  }
  showDashboard();
  await loadCurrentView();
}

async function login(event) {
  event.preventDefault();
  if (!$("[data-register-fields]").hidden) {
    await register();
    return;
  }
  const form = event.currentTarget;
  try {
    const data = await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        email: form.email.value,
        password: form.password.value
      })
    });
    state.user = data.user;
    showDashboard();
    await loadCurrentView();
  } catch (error) {
    setAuthMessage(error.message, true);
  }
}

async function register() {
  const form = $("[data-login-form]");
  try {
    const data = await api("/api/admin/register", {
      method: "POST",
      body: JSON.stringify({
        name: form.name.value,
        email: form.registerEmail.value,
        password: form.registerPassword.value,
        setupCode: form.setupCode.value
      })
    });
    if (data.authenticated) {
      state.user = data.user;
      showDashboard();
      await loadCurrentView();
    } else {
      setAuthMessage(data.message || "Access request submitted.");
    }
  } catch (error) {
    setAuthMessage(error.message, true);
  }
}

async function logout() {
  await api("/api/admin/logout", { method: "POST" });
  state.user = null;
  showAuth();
}

function setView(view) {
  state.view = view;
  renderView();
  loadCurrentView().catch((error) => toast(error.message));
}

function renderView() {
  document.querySelectorAll("[data-view-button]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.viewButton === state.view);
  });
  document.querySelectorAll("[data-view]").forEach((view) => {
    view.classList.toggle("is-active", view.dataset.view === state.view);
  });
  const [eyebrow, title] = viewTitles[state.view] || viewTitles.requests;
  $("[data-section-eyebrow]").textContent = eyebrow;
  $("[data-section-title]").textContent = title;
}

async function loadCurrentView() {
  if (state.view === "requests") await loadRequests();
  if (state.view === "editor") await loadPages();
  if (state.view === "media") await loadMedia();
  if (state.view === "notifications") await loadNotifications();
  if (state.view === "users") await loadUsers();
}

async function loadRequests() {
  const [requestsData, summaryData] = await Promise.all([
    api("/api/admin/requests"),
    api("/api/admin/summary")
  ]);
  state.requests = requestsData.requests || [];
  state.summary = summaryData.summary || {};
  if (!state.selectedRequestId || !state.requests.some((request) => request.id === state.selectedRequestId)) {
    state.selectedRequestId = state.requests[0]?.id || "";
  }
  renderSummary();
  renderRequests();
}

function renderSummary() {
  const summary = state.summary || {};
  $("[data-summary]").innerHTML = [
    ["Total Requests", summary.totalRequests || 0],
    ["New Requests", summary.newRequests || 0],
    ["Pages", summary.pages || 0],
    ["Media", summary.media || 0]
  ].map(([label, value]) => `
    <article class="metric-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `).join("");
}

function statusPill(status) {
  return `<span class="pill ${escapeHtml(status || "new")}">${escapeHtml(status || "new")}</span>`;
}

function renderRequests() {
  const list = $("[data-request-list]");
  list.innerHTML = state.requests.length
    ? state.requests.map((request) => `
      <button class="request-card ${request.id === state.selectedRequestId ? "is-active" : ""}" type="button" data-request-id="${escapeHtml(request.id)}">
        <strong>${escapeHtml(request.name || "Unknown")}</strong>
        <span>${escapeHtml(request.selectedServices || "No services")}</span>
        <span>${formatDate(request.createdAt)}</span>
        ${statusPill(request.status)}
      </button>
    `).join("")
    : `<p class="empty-state">No requests yet.</p>`;
  renderRequestDetail();
}

function renderRequestDetail() {
  const detail = $("[data-request-detail]");
  const request = state.requests.find((item) => item.id === state.selectedRequestId);
  if (!request) {
    detail.innerHTML = `<p class="empty-state">Choose a request.</p>`;
    return;
  }
  detail.innerHTML = `
    <div>
      <h3>${escapeHtml(request.name)}</h3>
      <small>${formatDate(request.createdAt)} - ${escapeHtml(request.id)}</small>
    </div>
    <div class="detail-grid">
      <div class="detail-item"><span>Email</span><a href="mailto:${escapeHtml(request.email)}">${escapeHtml(request.email)}</a></div>
      <div class="detail-item"><span>Phone</span><strong>${escapeHtml(request.phone || "Not provided")}</strong></div>
      <div class="detail-item"><span>Timeline</span><strong>${escapeHtml(request.timeline || "Not provided")}</strong></div>
      <div class="detail-item"><span>Estimate</span><strong>${escapeHtml(request.estimatedCost || "Not calculated")}</strong></div>
      <div class="detail-item"><span>Services</span><strong>${escapeHtml(request.selectedServices)}</strong></div>
      <div class="detail-item"><span>Status</span>${statusPill(request.status)}</div>
    </div>
    <div class="message-box">${escapeHtml(request.message)}</div>
    <label>Status<select data-request-status>
      ${["new", "reviewed", "accepted", "declined", "archived"].map((status) => `<option value="${status}" ${status === request.status ? "selected" : ""}>${status}</option>`).join("")}
    </select></label>
    <label>Notes<textarea data-request-notes rows="4">${escapeHtml(request.notes || "")}</textarea></label>
    <div class="detail-actions">
      <button class="admin-button primary" type="button" data-save-request="${escapeHtml(request.id)}">Save Request</button>
      <button class="admin-button danger" type="button" data-delete-request="${escapeHtml(request.id)}">Delete</button>
    </div>
  `;
}

async function saveRequest(id) {
  const detail = $("[data-request-detail]");
  const data = await api(`/api/admin/requests/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: $("[data-request-status]", detail).value,
      notes: $("[data-request-notes]", detail).value
    })
  });
  state.requests = data.requests || state.requests;
  renderRequests();
  toast("Request saved.");
}

async function deleteRequest(id) {
  if (!window.confirm("Delete this contact request?")) return;
  const data = await api(`/api/admin/requests/${encodeURIComponent(id)}`, { method: "DELETE" });
  state.requests = data.requests || [];
  state.selectedRequestId = state.requests[0]?.id || "";
  renderRequests();
  toast("Request deleted.");
}

async function loadPages() {
  const data = await api("/api/admin/pages");
  state.pages = data.pages || [];
  if (!state.pages.some((page) => page.key === state.selectedPageKey)) {
    state.selectedPageKey = state.pages[0]?.key || "home";
  }
  renderPageTabs();
  await loadPage(state.selectedPageKey);
}

function renderPageTabs() {
  $("[data-page-tabs]").innerHTML = state.pages.map((page) => `
    <button class="${page.key === state.selectedPageKey ? "is-active" : ""}" type="button" data-page-key="${escapeHtml(page.key)}">${escapeHtml(page.label)}</button>
  `).join("");
}

async function loadPage(key) {
  const data = await api(`/api/admin/pages/${encodeURIComponent(key)}`);
  state.selectedPageKey = key;
  state.pageContent = data.content || "";
  state.pages = state.pages.map((page) => page.key === data.page.key ? data.page : page);
  renderPageTabs();
  renderPageEditor(data.page);
}

function renderPageEditor(page = state.pages.find((item) => item.key === state.selectedPageKey)) {
  $("[data-page-source]").value = state.pageContent;
  const route = `${page?.route || "/"}?preview=${Date.now()}`;
  $("[data-preview-frame]").src = route;
  $("[data-open-preview]").href = page?.route || "/";
  $("[data-preview-label]").textContent = page ? `${page.label} - ${page.file}` : "Preview";
}

async function savePage() {
  const content = $("[data-page-source]").value;
  const data = await api(`/api/admin/pages/${encodeURIComponent(state.selectedPageKey)}`, {
    method: "POST",
    body: JSON.stringify({ content })
  });
  state.pageContent = data.content || content;
  state.pages = state.pages.map((page) => page.key === data.page.key ? data.page : page);
  renderPageEditor(data.page);
  toast("Page saved.");
}

async function loadMedia() {
  const data = await api("/api/admin/media");
  state.media = data.media || [];
  renderMedia();
}

function renderMedia() {
  $("[data-media-grid]").innerHTML = state.media.length
    ? state.media.map((item) => `
      <article class="media-item">
        <img src="${escapeHtml(item.url)}" alt="">
        <strong>${escapeHtml(item.name)}</strong>
        <code>${escapeHtml(item.url)}</code>
        <span class="pill">${formatBytes(item.size)}</span>
        <div class="inline-actions">
          <button class="admin-button" type="button" data-copy-media="${escapeHtml(item.url)}">Copy URL</button>
          <button class="admin-button danger" type="button" data-delete-media="${escapeHtml(item.name)}">Delete</button>
        </div>
      </article>
    `).join("")
    : `<p class="empty-state">No media uploaded.</p>`;
}

async function uploadMedia(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const data = await api("/api/admin/media", { method: "POST", body: formData });
  state.media = data.media || [];
  form.reset();
  renderMedia();
  toast("Media uploaded.");
}

async function deleteMedia(name) {
  if (!window.confirm("Delete this media file?")) return;
  const data = await api(`/api/admin/media/${encodeURIComponent(name)}`, { method: "DELETE" });
  state.media = data.media || [];
  renderMedia();
  toast("Media deleted.");
}

async function loadNotifications() {
  const data = await api("/api/admin/notifications");
  state.notifications = data.notifications || {};
  state.providers = data.providers || {};
  renderNotifications();
}

function notificationPayload() {
  const form = $("[data-notification-form]");
  return {
    email: {
      enabled: form.emailEnabled.checked,
      address: form.emailAddress.value
    },
    discord: {
      enabled: form.discordEnabled.checked,
      webhookUrl: form.discordWebhookUrl.value
    }
  };
}

function renderNotifications() {
  const form = $("[data-notification-form]");
  form.emailEnabled.checked = Boolean(state.notifications?.email?.enabled);
  form.emailAddress.value = state.notifications?.email?.address || "";
  form.discordEnabled.checked = Boolean(state.notifications?.discord?.enabled);
  form.discordWebhookUrl.value = state.notifications?.discord?.webhookUrl || "";
  $("[data-email-provider]").textContent = state.providers.email ? "SMTP connected." : "SMTP is not configured.";
}

async function saveNotifications(event) {
  event.preventDefault();
  const data = await api("/api/admin/notifications", {
    method: "POST",
    body: JSON.stringify({ notifications: notificationPayload() })
  });
  state.notifications = data.notifications;
  renderNotifications();
  toast("Notifications saved.");
}

async function testNotifications() {
  const data = await api("/api/admin/notifications/test", {
    method: "POST",
    body: JSON.stringify({ notifications: notificationPayload() })
  });
  state.notifications = data.notifications;
  renderNotifications();
  toast("Test notification sent.");
}

async function loadUsers() {
  const data = await api("/api/admin/users");
  state.users = data.users || [];
  renderUsers();
}

function renderUsers() {
  $("[data-user-list]").innerHTML = state.users.length
    ? state.users.map((user) => `
      <article class="user-row">
        <div>
          <strong>${escapeHtml(user.name)}</strong>
          <span>${escapeHtml(user.email)}</span>
        </div>
        <label>Role<select data-user-role="${escapeHtml(user.id)}" ${user.role === "owner" ? "disabled" : ""}>
          ${["viewer", "editor", "admin"].map((role) => `<option value="${role}" ${role === user.role ? "selected" : ""}>${role}</option>`).join("")}
          ${user.role === "owner" ? `<option value="owner" selected>owner</option>` : ""}
        </select></label>
        <label class="toggle-row"><input type="checkbox" data-user-approved="${escapeHtml(user.id)}" ${user.approved ? "checked" : ""} ${user.role === "owner" ? "disabled" : ""}> Approved</label>
        <div class="inline-actions">
          <button class="admin-button primary" type="button" data-save-user="${escapeHtml(user.id)}" ${user.role === "owner" ? "disabled" : ""}>Save</button>
          <button class="admin-button danger" type="button" data-delete-user="${escapeHtml(user.id)}" ${user.role === "owner" || user.id === state.user?.id ? "disabled" : ""}>Delete</button>
        </div>
      </article>
    `).join("")
    : `<p class="empty-state">No accounts found.</p>`;
}

async function saveUser(id) {
  const data = await api(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      role: document.querySelector(`[data-user-role="${CSS.escape(id)}"]`)?.value,
      approved: document.querySelector(`[data-user-approved="${CSS.escape(id)}"]`)?.checked
    })
  });
  state.users = data.users || [];
  renderUsers();
  toast("Account saved.");
}

async function deleteUser(id) {
  if (!window.confirm("Delete this admin account?")) return;
  const data = await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" });
  state.users = data.users || [];
  renderUsers();
  toast("Account deleted.");
}

document.addEventListener("click", (event) => {
  const authTab = event.target.closest("[data-auth-tab]");
  if (authTab) toggleAuthTab(authTab.dataset.authTab);

  const registerButton = event.target.closest("[data-register-submit]");
  if (registerButton) register().catch((error) => setAuthMessage(error.message, true));

  const viewButton = event.target.closest("[data-view-button]");
  if (viewButton) setView(viewButton.dataset.viewButton);

  const refreshButton = event.target.closest("[data-refresh]");
  if (refreshButton) loadCurrentView().catch((error) => toast(error.message));

  const logoutButton = event.target.closest("[data-logout]");
  if (logoutButton) logout().catch((error) => toast(error.message));

  const requestButton = event.target.closest("[data-request-id]");
  if (requestButton) {
    state.selectedRequestId = requestButton.dataset.requestId;
    renderRequests();
  }

  const saveRequestButton = event.target.closest("[data-save-request]");
  if (saveRequestButton) saveRequest(saveRequestButton.dataset.saveRequest).catch((error) => toast(error.message));

  const deleteRequestButton = event.target.closest("[data-delete-request]");
  if (deleteRequestButton) deleteRequest(deleteRequestButton.dataset.deleteRequest).catch((error) => toast(error.message));

  const pageButton = event.target.closest("[data-page-key]");
  if (pageButton) loadPage(pageButton.dataset.pageKey).catch((error) => toast(error.message));

  const reloadPageButton = event.target.closest("[data-reload-page]");
  if (reloadPageButton) loadPage(state.selectedPageKey).catch((error) => toast(error.message));

  const savePageButton = event.target.closest("[data-save-page]");
  if (savePageButton) savePage().catch((error) => toast(error.message));

  const copyMediaButton = event.target.closest("[data-copy-media]");
  if (copyMediaButton) {
    navigator.clipboard?.writeText(copyMediaButton.dataset.copyMedia).then(() => toast("Media URL copied."));
  }

  const deleteMediaButton = event.target.closest("[data-delete-media]");
  if (deleteMediaButton) deleteMedia(deleteMediaButton.dataset.deleteMedia).catch((error) => toast(error.message));

  const testButton = event.target.closest("[data-test-notifications]");
  if (testButton) testNotifications().catch((error) => toast(error.message));

  const saveUserButton = event.target.closest("[data-save-user]");
  if (saveUserButton) saveUser(saveUserButton.dataset.saveUser).catch((error) => toast(error.message));

  const deleteUserButton = event.target.closest("[data-delete-user]");
  if (deleteUserButton) deleteUser(deleteUserButton.dataset.deleteUser).catch((error) => toast(error.message));
});

$("[data-login-form]").addEventListener("submit", login);
$("[data-media-form]").addEventListener("submit", (event) => uploadMedia(event).catch((error) => toast(error.message)));
$("[data-notification-form]").addEventListener("submit", (event) => saveNotifications(event).catch((error) => toast(error.message)));

bootstrap().catch((error) => {
  showAuth();
  setAuthMessage(error.message, true);
});
