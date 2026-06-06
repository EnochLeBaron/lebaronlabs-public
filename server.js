const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const express = require("express");
const nodemailer = require("nodemailer");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();
const ROOT = __dirname;
const ADMIN_ROOT = path.join(ROOT, "admin");
const DATA_ROOT = process.env.DATA_ROOT ? path.resolve(process.env.DATA_ROOT) : path.join(ROOT, "Site Data");
const MEDIA_ROOT = process.env.MEDIA_ROOT ? path.resolve(process.env.MEDIA_ROOT) : path.join(ROOT, "Managed Media");
const PAGE_BACKUP_ROOT = path.join(DATA_ROOT, "Page Backups");
const USERS_FILE = path.join(DATA_ROOT, "admin-users.json");
const SESSIONS_FILE = path.join(DATA_ROOT, "admin-sessions.json");
const REQUESTS_FILE = path.join(DATA_ROOT, "contact-requests.json");
const NOTIFICATIONS_FILE = path.join(DATA_ROOT, "notifications.json");
const SETUP_CODE_FILE = path.join(DATA_ROOT, "setup-code.txt");
const SESSION_COOKIE = "lbl_admin_session";
const SESSION_DAYS = 7;
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
const MAX_JSON_BYTES = "2mb";

const PAGE_FILES = [
    { key: "home", label: "Home", route: "/", file: "index.html" },
    { key: "development", label: "Development", route: "/html/development.html", file: "html/development.html" },
    { key: "design", label: "Design", route: "/html/design.html", file: "html/design.html" },
    { key: "hosting", label: "Hosting", route: "/html/hosting.html", file: "html/hosting.html" },
    { key: "projects", label: "Projects", route: "/html/projects.html", file: "html/projects.html" },
    { key: "contact", label: "Contact", route: "/html/contact.html", file: "html/contact.html" },
    { key: "tools", label: "Tools Home", route: "/app-home", file: "app-home.html" },
    { key: "privacy", label: "Privacy", route: "/privacy", file: "privacy.html" },
    { key: "terms", label: "Terms", route: "/terms", file: "terms.html" }
];

const DEFAULT_NOTIFICATIONS = {
    email: {
        enabled: true,
        address: process.env.CONTACT_EMAIL_TO || ""
    },
    discord: {
        enabled: false,
        webhookUrl: ""
    }
};

app.set("trust proxy", 1);
app.use(express.json({ limit: MAX_JSON_BYTES }));
app.use(express.urlencoded({ extended: true, limit: MAX_JSON_BYTES }));

const contactLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many requests. Please wait and try again."
    }
});

const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 80,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many admin requests. Please wait and try again."
    }
});

function ensureStorage() {
    [DATA_ROOT, MEDIA_ROOT, PAGE_BACKUP_ROOT, ADMIN_ROOT].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
    if (!fs.existsSync(USERS_FILE)) writeJson(USERS_FILE, []);
    if (!fs.existsSync(SESSIONS_FILE)) writeJson(SESSIONS_FILE, {});
    if (!fs.existsSync(REQUESTS_FILE)) writeJson(REQUESTS_FILE, []);
    if (!fs.existsSync(NOTIFICATIONS_FILE)) writeJson(NOTIFICATIONS_FILE, DEFAULT_NOTIFICATIONS);
    if (!readJson(USERS_FILE, []).length && !fs.existsSync(SETUP_CODE_FILE)) {
        fs.writeFileSync(SETUP_CODE_FILE, crypto.randomBytes(18).toString("base64url"));
    }
}

function readJson(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (_error) {
        return JSON.parse(JSON.stringify(fallback));
    }
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
    fs.renameSync(tempPath, filePath);
}

function cleanText(value, max = 4000) {
    return String(value || "").replace(/[<>]/g, "").trim().slice(0, max);
}

function cleanEmail(value) {
    return cleanText(value, 320).toLowerCase();
}

function cleanRole(value) {
    return ["owner", "admin", "editor", "viewer"].includes(value) ? value : "viewer";
}

function safeUser(user) {
    if (!user) return null;
    const { passwordHash, ...safe } = user;
    return safe;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    const hash = crypto.pbkdf2Sync(String(password), salt, 210000, 32, "sha256").toString("hex");
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash = "") {
    const [salt, hash] = String(storedHash).split(":");
    if (!salt || !hash) return false;
    const nextHash = hashPassword(password, salt).split(":")[1];
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(nextHash, "hex"));
}

function parseCookies(req) {
    return String(req.headers.cookie || "")
        .split(";")
        .map((item) => item.trim())
        .filter(Boolean)
        .reduce((cookies, item) => {
            const index = item.indexOf("=");
            if (index === -1) return cookies;
            cookies[item.slice(0, index)] = decodeURIComponent(item.slice(index + 1));
            return cookies;
        }, {});
}

function cookieIsSecure(req) {
    return req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0] === "https";
}

function readUsers() {
    return readJson(USERS_FILE, []);
}

function writeUsers(users) {
    writeJson(USERS_FILE, users);
}

function readSessions() {
    return readJson(SESSIONS_FILE, {});
}

function writeSessions(sessions) {
    writeJson(SESSIONS_FILE, sessions);
}

function currentUser(req) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return null;
    const sessions = readSessions();
    const session = sessions[token];
    if (!session || new Date(session.expiresAt).getTime() < Date.now()) {
        delete sessions[token];
        writeSessions(sessions);
        return null;
    }
    const user = readUsers().find((item) => item.id === session.userId);
    return user && user.approved ? user : null;
}

function createSession(req, res, user) {
    const token = crypto.randomBytes(32).toString("base64url");
    const sessions = readSessions();
    sessions[token] = {
        userId: user.id,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString()
    };
    writeSessions(sessions);
    res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: cookieIsSecure(req),
        maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
    });
}

function destroySession(req, res) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) {
        const sessions = readSessions();
        delete sessions[token];
        writeSessions(sessions);
    }
    res.clearCookie(SESSION_COOKIE);
}

function requireAdmin(req, res, next) {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ success: false, message: "Admin login required." });
    req.adminUser = user;
    next();
}

function requireUserManager(req, res, next) {
    if (!["owner", "admin"].includes(req.adminUser?.role)) {
        return res.status(403).json({ success: false, message: "Admin account management access required." });
    }
    next();
}

function setupRequired() {
    return !readUsers().length;
}

function readNotifications() {
    const current = readJson(NOTIFICATIONS_FILE, DEFAULT_NOTIFICATIONS);
    return {
        email: {
            enabled: Boolean(current.email?.enabled),
            address: cleanEmail(current.email?.address || process.env.CONTACT_EMAIL_TO || "")
        },
        discord: {
            enabled: Boolean(current.discord?.enabled),
            webhookUrl: cleanText(current.discord?.webhookUrl, 1200)
        }
    };
}

function writeNotifications(notifications) {
    const clean = readNotificationsFromPayload(notifications);
    writeJson(NOTIFICATIONS_FILE, clean);
    return clean;
}

function readNotificationsFromPayload(value = {}) {
    return {
        email: {
            enabled: Boolean(value.email?.enabled),
            address: cleanEmail(value.email?.address || "")
        },
        discord: {
            enabled: Boolean(value.discord?.enabled),
            webhookUrl: cleanText(value.discord?.webhookUrl, 1200)
        }
    };
}

function smtpConfigured() {
    return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function makeTransporter() {
    if (!smtpConfigured()) return null;
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });
}

function contactEmailHtml(submission) {
    return `
        <div style="font-family:Arial,sans-serif;background:#f4f7fb;padding:24px;">
            <div style="max-width:680px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;border:1px solid #dce3ee;">
                <div style="background:#07111f;color:white;padding:24px;">
                    <h1 style="margin:0;font-size:24px;">New LeBaronLabs Project Request</h1>
                    <p style="margin:8px 0 0;color:#b8c4d6;">A new public site contact request was received.</p>
                </div>
                <div style="padding:24px;">
                    <p><strong>Name:</strong> ${submission.name}</p>
                    <p><strong>Email:</strong> ${submission.email}</p>
                    <p><strong>Phone:</strong> ${submission.phone || "Not provided"}</p>
                    <p><strong>Timeline:</strong> ${submission.timeline || "Not provided"}</p>
                    <hr style="border:none;border-top:1px solid #e6ebf2;margin:22px 0;">
                    <p><strong>Selected Services:</strong></p>
                    <p>${submission.selectedServices}</p>
                    <p><strong>Estimated Cost:</strong> ${submission.estimatedCost || "Not calculated"}</p>
                    <hr style="border:none;border-top:1px solid #e6ebf2;margin:22px 0;">
                    <p><strong>Project Details:</strong></p>
                    <p style="white-space:pre-line;line-height:1.6;">${submission.message}</p>
                    <p style="margin-top:22px;"><a href="${process.env.ADMIN_URL || "/admin"}">Open LeBaronLabs Admin</a></p>
                </div>
            </div>
        </div>
    `;
}

function contactEmailText(submission) {
    return [
        "New LeBaronLabs Project Request",
        "",
        `Name: ${submission.name}`,
        `Email: ${submission.email}`,
        `Phone: ${submission.phone || "Not provided"}`,
        `Timeline: ${submission.timeline || "Not provided"}`,
        "",
        "Selected Services:",
        submission.selectedServices,
        "",
        `Estimated Cost: ${submission.estimatedCost || "Not calculated"}`,
        "",
        "Project Details:",
        submission.message
    ].join("\n");
}

async function sendEmailNotification(submission, notifications = readNotifications()) {
    if (!notifications.email.enabled || !notifications.email.address) return { skipped: true };
    const transporter = makeTransporter();
    if (!transporter) return { skipped: true, message: "SMTP is not configured." };
    await transporter.sendMail({
        from: `"LeBaronLabs Contact Form" <${process.env.SMTP_USER}>`,
        to: notifications.email.address,
        replyTo: submission.email,
        subject: `New LeBaronLabs request from ${submission.name}`,
        html: contactEmailHtml(submission),
        text: contactEmailText(submission)
    });
    return { sent: true };
}

async function sendDiscordNotification(submission, notifications = readNotifications()) {
    if (!notifications.discord.enabled || !notifications.discord.webhookUrl) return { skipped: true };
    const response = await fetch(notifications.discord.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            username: "LeBaronLabs Admin",
            embeds: [{
                title: "New LeBaronLabs project request",
                color: 2855679,
                fields: [
                    { name: "Name", value: submission.name || "Not provided", inline: true },
                    { name: "Email", value: submission.email || "Not provided", inline: true },
                    { name: "Services", value: submission.selectedServices || "Not provided" },
                    { name: "Estimate", value: submission.estimatedCost || "Not calculated", inline: true }
                ],
                description: (submission.message || "").slice(0, 1000),
                timestamp: submission.createdAt
            }]
        })
    });
    if (!response.ok) throw new Error(`Discord returned ${response.status}.`);
    return { sent: true };
}

async function sendNotifications(submission) {
    const notifications = readNotifications();
    const results = {};
    try {
        results.email = await sendEmailNotification(submission, notifications);
    } catch (error) {
        results.email = { error: error.message };
        console.error("Email notification failed:", error);
    }
    try {
        results.discord = await sendDiscordNotification(submission, notifications);
    } catch (error) {
        results.discord = { error: error.message };
        console.error("Discord notification failed:", error);
    }
    return results;
}

function readRequests() {
    return readJson(REQUESTS_FILE, []);
}

function writeRequests(requests) {
    writeJson(REQUESTS_FILE, requests);
}

function saveContactSubmission(fields) {
    const submission = {
        id: `${Date.now()}-${crypto.randomBytes(5).toString("hex")}`,
        status: "new",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        name: cleanText(fields.name, 180),
        email: cleanEmail(fields.email),
        phone: cleanText(fields.phone, 80),
        timeline: cleanText(fields.timeline, 80),
        selectedServices: cleanText(fields.selectedServices, 1200),
        estimatedCost: cleanText(fields.estimatedCost, 180),
        message: cleanText(fields.message, 4000),
        notes: ""
    };
    const requests = readRequests();
    requests.unshift(submission);
    writeRequests(requests);
    return submission;
}

function updateRequest(id, patch) {
    const requests = readRequests();
    const index = requests.findIndex((item) => item.id === id);
    if (index === -1) return null;
    requests[index] = {
        ...requests[index],
        status: ["new", "reviewed", "accepted", "declined", "archived"].includes(patch.status) ? patch.status : requests[index].status,
        notes: cleanText(patch.notes ?? requests[index].notes, 3000),
        updatedAt: new Date().toISOString()
    };
    writeRequests(requests);
    return requests[index];
}

function deleteRequest(id) {
    const requests = readRequests();
    const next = requests.filter((item) => item.id !== id);
    if (next.length === requests.length) return false;
    writeRequests(next);
    return true;
}

function pageForKey(key) {
    return PAGE_FILES.find((page) => page.key === key);
}

function pagePath(page) {
    const resolved = path.resolve(ROOT, page.file);
    if (!resolved.startsWith(path.resolve(ROOT) + path.sep)) {
        throw new Error("Invalid page path.");
    }
    return resolved;
}

function pageSummary(page) {
    const filePath = pagePath(page);
    const stats = fs.statSync(filePath);
    return {
        key: page.key,
        label: page.label,
        route: page.route,
        file: page.file,
        size: stats.size,
        updatedAt: stats.mtime.toISOString()
    };
}

function backupPage(page, currentContent) {
    fs.mkdirSync(PAGE_BACKUP_ROOT, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupName = `${page.key}-${stamp}.html`;
    fs.writeFileSync(path.join(PAGE_BACKUP_ROOT, backupName), currentContent);
}

async function readRequestBuffer(req, maxBytes = MAX_UPLOAD_BYTES) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > maxBytes) {
            const error = new Error("Upload is too large.");
            error.status = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function trimMultipartLineBreaks(buffer) {
    let start = 0;
    let end = buffer.length;
    while (start < end && (buffer[start] === 13 || buffer[start] === 10)) start += 1;
    while (end > start && (buffer[end - 1] === 13 || buffer[end - 1] === 10)) end -= 1;
    return buffer.slice(start, end);
}

function parseContentDisposition(value = "") {
    return value.split(";").map((part) => part.trim()).reduce((result, part) => {
        const index = part.indexOf("=");
        if (index === -1) return result;
        const key = part.slice(0, index).toLowerCase();
        result[key] = part.slice(index + 1).replace(/^"|"$/g, "");
        return result;
    }, {});
}

function parseMultipart(body, boundary) {
    const delimiter = Buffer.from(`--${boundary}`);
    const headerBreak = Buffer.from("\r\n\r\n");
    const parts = [];
    let cursor = body.indexOf(delimiter);
    while (cursor !== -1) {
        const next = body.indexOf(delimiter, cursor + delimiter.length);
        if (next === -1) break;
        const segment = trimMultipartLineBreaks(body.slice(cursor + delimiter.length, next));
        cursor = next;
        if (!segment.length || segment.slice(0, 2).toString() === "--") continue;
        const headerEnd = segment.indexOf(headerBreak);
        if (headerEnd === -1) continue;
        const rawHeaders = segment.slice(0, headerEnd).toString("latin1");
        const content = trimMultipartLineBreaks(segment.slice(headerEnd + headerBreak.length));
        const headers = {};
        rawHeaders.split("\r\n").forEach((line) => {
            const separator = line.indexOf(":");
            if (separator !== -1) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
        });
        const disposition = parseContentDisposition(headers["content-disposition"]);
        parts.push({
            name: disposition.name,
            filename: disposition.filename,
            contentType: headers["content-type"] || "application/octet-stream",
            content
        });
    }
    return parts;
}

async function parseMultipartRequest(req) {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundaryMatch) {
        const error = new Error("Missing multipart boundary.");
        error.status = 400;
        throw error;
    }
    return parseMultipart(await readRequestBuffer(req), boundaryMatch[1] || boundaryMatch[2]);
}

function safeFileName(value = "upload") {
    const parsed = path.parse(path.basename(String(value || "upload")));
    const name = (parsed.name || "upload")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
        .replace(/[. ]+$/g, "")
        .trim()
        .slice(0, 80) || "upload";
    const ext = (parsed.ext || "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").slice(0, 16);
    return `${name}${ext}`;
}

function mediaUrl(fileName) {
    return `/Managed%20Media/${encodeURIComponent(fileName)}`;
}

function listMedia() {
    fs.mkdirSync(MEDIA_ROOT, { recursive: true });
    return fs.readdirSync(MEDIA_ROOT)
        .filter((name) => fs.statSync(path.join(MEDIA_ROOT, name)).isFile())
        .map((name) => {
            const stats = fs.statSync(path.join(MEDIA_ROOT, name));
            return {
                name,
                url: mediaUrl(name),
                size: stats.size,
                updatedAt: stats.mtime.toISOString()
            };
        })
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function blockedStaticPath(reqPath) {
    const decoded = decodeURIComponent(reqPath || "").replace(/\\/g, "/").toLowerCase();
    const first = decoded.split("/").filter(Boolean)[0] || "";
    if (["site data", "node_modules", ".git"].includes(first)) return true;
    return [".env", "server.js", "package.json", "package-lock.json", "ecosystem.config.js"].includes(path.basename(decoded));
}

ensureStorage();

app.use((req, res, next) => {
    if (blockedStaticPath(req.path)) return res.status(404).send("Not found");
    next();
});

app.use("/admin", express.static(ADMIN_ROOT, { index: false }));
app.use("/Managed%20Media", express.static(MEDIA_ROOT, { index: false }));
app.use("/Managed Media", express.static(MEDIA_ROOT, { index: false }));

app.get("/admin", (_req, res) => res.sendFile(path.join(ADMIN_ROOT, "index.html")));
app.get("/admin/", (_req, res) => res.sendFile(path.join(ADMIN_ROOT, "index.html")));

app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "index.html")));
app.get("/app-home", (_req, res) => res.sendFile(path.join(ROOT, "app-home.html")));
app.get("/privacy", (_req, res) => res.sendFile(path.join(ROOT, "privacy.html")));
app.get("/terms", (_req, res) => res.sendFile(path.join(ROOT, "terms.html")));

app.post("/api/contact", contactLimiter, async (req, res) => {
    const name = cleanText(req.body.name, 180);
    const email = cleanEmail(req.body.email);
    const selectedServices = cleanText(req.body.selectedServices, 1200);
    const message = cleanText(req.body.message, 4000);
    if (!name || !email || !message || !selectedServices) {
        return res.status(400).json({
            success: false,
            message: "Please fill out your name, email, services, and project details."
        });
    }

    const submission = saveContactSubmission({
        ...req.body,
        name,
        email,
        selectedServices,
        message
    });
    const notificationResults = await sendNotifications(submission);
    updateRequest(submission.id, { status: submission.status, notes: submission.notes });

    res.json({
        success: true,
        message: "Your request was sent successfully.",
        requestId: submission.id,
        notifications: notificationResults
    });
});

const adminRouter = express.Router();
adminRouter.use(adminLimiter);

adminRouter.get("/me", (req, res) => {
    const user = currentUser(req);
    res.json({
        success: true,
        authenticated: Boolean(user),
        user: safeUser(user),
        setupRequired: setupRequired()
    });
});

adminRouter.post("/register", (req, res) => {
    const users = readUsers();
    const firstUser = users.length === 0;
    const name = cleanText(req.body.name, 160);
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || "");
    const setupCode = String(req.body.setupCode || "").trim();
    if (!name || !email || password.length < 10) {
        return res.status(400).json({ success: false, message: "Name, email, and a 10 character password are required." });
    }
    if (users.some((user) => user.email === email)) {
        return res.status(409).json({ success: false, message: "An account already exists for that email." });
    }
    const savedSetupCode = fs.existsSync(SETUP_CODE_FILE) ? fs.readFileSync(SETUP_CODE_FILE, "utf8").trim() : "";
    if (firstUser && setupCode !== savedSetupCode) {
        return res.status(403).json({ success: false, message: "First admin setup code is required." });
    }
    const user = {
        id: crypto.randomUUID(),
        name,
        email,
        passwordHash: hashPassword(password),
        role: firstUser ? "owner" : "editor",
        approved: firstUser,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastLoginAt: ""
    };
    users.push(user);
    writeUsers(users);
    if (firstUser) createSession(req, res, user);
    res.json({
        success: true,
        authenticated: firstUser,
        user: safeUser(firstUser ? user : null),
        message: firstUser ? "Owner account created." : "Access request submitted."
    });
});

adminRouter.post("/login", (req, res) => {
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || "");
    const users = readUsers();
    const user = users.find((item) => item.email === email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
        return res.status(401).json({ success: false, message: "Invalid email or password." });
    }
    if (!user.approved) {
        return res.status(403).json({ success: false, message: "This account is waiting for approval." });
    }
    user.lastLoginAt = new Date().toISOString();
    user.updatedAt = user.lastLoginAt;
    writeUsers(users);
    createSession(req, res, user);
    res.json({ success: true, user: safeUser(user) });
});

adminRouter.post("/logout", (req, res) => {
    destroySession(req, res);
    res.json({ success: true });
});

adminRouter.use(requireAdmin);

adminRouter.get("/summary", (_req, res) => {
    const requests = readRequests();
    res.json({
        success: true,
        summary: {
            totalRequests: requests.length,
            newRequests: requests.filter((item) => item.status === "new").length,
            pages: PAGE_FILES.length,
            media: listMedia().length
        }
    });
});

adminRouter.get("/requests", (_req, res) => {
    res.json({ success: true, requests: readRequests() });
});

adminRouter.patch("/requests/:id", (req, res) => {
    const request = updateRequest(req.params.id, req.body || {});
    if (!request) return res.status(404).json({ success: false, message: "Request not found." });
    res.json({ success: true, request, requests: readRequests() });
});

adminRouter.delete("/requests/:id", (req, res) => {
    if (!deleteRequest(req.params.id)) return res.status(404).json({ success: false, message: "Request not found." });
    res.json({ success: true, requests: readRequests() });
});

adminRouter.get("/pages", (_req, res) => {
    res.json({ success: true, pages: PAGE_FILES.map(pageSummary) });
});

adminRouter.get("/pages/:key", (req, res) => {
    const page = pageForKey(req.params.key);
    if (!page) return res.status(404).json({ success: false, message: "Page not found." });
    res.json({
        success: true,
        page: pageSummary(page),
        content: fs.readFileSync(pagePath(page), "utf8")
    });
});

adminRouter.post("/pages/:key", (req, res) => {
    const page = pageForKey(req.params.key);
    if (!page) return res.status(404).json({ success: false, message: "Page not found." });
    const nextContent = String(req.body.content || "");
    if (!nextContent.trim()) return res.status(400).json({ success: false, message: "Page content cannot be empty." });
    const target = pagePath(page);
    const current = fs.readFileSync(target, "utf8");
    backupPage(page, current);
    fs.writeFileSync(target, nextContent);
    res.json({ success: true, page: pageSummary(page), content: nextContent });
});

adminRouter.get("/media", (_req, res) => {
    res.json({ success: true, media: listMedia() });
});

adminRouter.post("/media", async (req, res, next) => {
    try {
        const parts = await parseMultipartRequest(req);
        const saved = [];
        for (const part of parts) {
            if (!part.filename || !part.content.length || !String(part.contentType).startsWith("image/")) continue;
            const fileName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safeFileName(part.filename)}`;
            fs.writeFileSync(path.join(MEDIA_ROOT, fileName), part.content);
            saved.push({ name: fileName, url: mediaUrl(fileName), size: part.content.length });
        }
        if (!saved.length) return res.status(400).json({ success: false, message: "Choose one or more image files." });
        res.json({ success: true, saved, media: listMedia() });
    } catch (error) {
        next(error);
    }
});

adminRouter.delete("/media/:name", (req, res) => {
    const fileName = path.basename(req.params.name);
    const target = path.resolve(MEDIA_ROOT, fileName);
    if (!target.startsWith(path.resolve(MEDIA_ROOT) + path.sep) || !fs.existsSync(target)) {
        return res.status(404).json({ success: false, message: "Media file not found." });
    }
    fs.unlinkSync(target);
    res.json({ success: true, media: listMedia() });
});

adminRouter.get("/notifications", (_req, res) => {
    res.json({
        success: true,
        notifications: readNotifications(),
        providers: {
            email: smtpConfigured(),
            discord: true
        }
    });
});

adminRouter.post("/notifications", (req, res) => {
    res.json({ success: true, notifications: writeNotifications(req.body.notifications || req.body) });
});

adminRouter.post("/notifications/test", async (req, res) => {
    const notifications = writeNotifications(req.body.notifications || readNotifications());
    const sample = {
        id: "test",
        createdAt: new Date().toISOString(),
        name: "Admin Test",
        email: notifications.email.address || process.env.CONTACT_EMAIL_TO || "test@example.com",
        phone: "",
        timeline: "Test",
        selectedServices: "LeBaronLabs Admin test",
        estimatedCost: "Test",
        message: "This is a test notification from LeBaronLabs Admin."
    };
    res.json({ success: true, notifications, results: await sendNotifications(sample) });
});

adminRouter.get("/users", requireUserManager, (_req, res) => {
    res.json({ success: true, users: readUsers().map(safeUser) });
});

adminRouter.patch("/users/:id", requireUserManager, (req, res) => {
    const users = readUsers();
    const user = users.find((item) => item.id === req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    user.approved = req.body.approved === undefined ? user.approved : Boolean(req.body.approved);
    user.role = user.role === "owner" ? "owner" : cleanRole(req.body.role || user.role);
    user.updatedAt = new Date().toISOString();
    writeUsers(users);
    res.json({ success: true, users: readUsers().map(safeUser) });
});

adminRouter.delete("/users/:id", requireUserManager, (req, res) => {
    if (req.adminUser.id === req.params.id) {
        return res.status(400).json({ success: false, message: "You cannot delete your own account." });
    }
    const users = readUsers();
    const target = users.find((item) => item.id === req.params.id);
    if (!target || target.role === "owner") {
        return res.status(400).json({ success: false, message: "That account cannot be deleted." });
    }
    writeUsers(users.filter((item) => item.id !== req.params.id));
    res.json({ success: true, users: readUsers().map(safeUser) });
});

app.use("/api/admin", adminRouter);
app.use(express.static(ROOT, { index: false, dotfiles: "ignore" }));

app.use((error, _req, res, _next) => {
    console.error("LeBaronLabs Public error:", error);
    res.status(error.status || 500).json({
        success: false,
        message: error.message || "Something went wrong."
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`LeBaronLabs Public running on http://localhost:${PORT}`);
    if (setupRequired()) {
        console.log(`LeBaronLabs Admin setup code: ${SETUP_CODE_FILE}`);
    }
});
