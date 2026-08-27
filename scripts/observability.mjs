import * as Sentry from "@sentry/node";

const sentryEnabled = Boolean(process.env.SENTRY_DSN);
const telegramEnabled = Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

const SECRET_KEY = /(key|token|secret|password|credential|authorization|cookie|dsn|private)/i;

function safeString(value, max = 320) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .slice(0, max);
}

function sanitize(value, depth = 0) {
  if (value == null) return value;
  if (depth > 2) return "[nested]";
  if (typeof value === "string") return safeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => sanitize(item, depth + 1));
  if (typeof value !== "object") return safeString(value);

  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (/^(dataUrl|image|screenshot|markdown|stdout|stderr|text|prompt|body)$/i.test(key)) {
      out[key] = `[omitted:${typeof raw}]`;
      continue;
    }
    out[key] = sanitize(raw, depth + 1);
  }
  return out;
}

export function initObservability({ service, workerId }) {
  if (!sentryEnabled) return false;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    release: process.env.SENTRY_RELEASE || process.env.npm_package_version,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
    serverName: process.env.CODE_AUDITOR_WORKER_HOST || undefined,
    initialScope: {
      tags: {
        service,
        workerId,
      },
    },
    beforeSend(event) {
      if (event.request) delete event.request;
      return event;
    },
  });
  return true;
}

export function recordWorkerEvent(jobId, level, phase, message, payload = {}) {
  if (!sentryEnabled) return;
  Sentry.addBreadcrumb({
    category: "cloud-worker",
    level: level === "error" ? "error" : level === "warn" ? "warning" : "info",
    message: safeString(message),
    data: {
      jobId,
      phase,
      ...sanitize(payload),
    },
  });

  if (level === "error" || level === "warn") {
    Sentry.captureMessage(safeString(message), {
      level: level === "error" ? "error" : "warning",
      tags: { jobId, phase },
      contexts: { cloudWorker: sanitize(payload) },
    });
  }
}

export function captureWorkerException(error, context = {}) {
  if (!sentryEnabled) return;
  Sentry.captureException(error, {
    tags: {
      jobId: context.jobId || "none",
      phase: context.phase || "worker",
    },
    contexts: {
      cloudWorker: sanitize(context),
    },
  });
}

export async function notifyOps({ title, body, level = "info", jobId = "", phase = "" }) {
  const text = [
    `${level.toUpperCase()}: ${safeString(title, 96)}`,
    body ? safeString(body, 800) : "",
    jobId ? `job: ${jobId}` : "",
    phase ? `phase: ${phase}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (sentryEnabled && (level === "error" || level === "warn")) {
    Sentry.captureMessage(`${title}: ${body || ""}`, {
      level: level === "error" ? "error" : "warning",
      tags: { jobId: jobId || "none", phase: phase || "ops" },
    });
  }

  if (!telegramEnabled) return false;
  const res = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    }
  );
  if (!res.ok) {
    const message = `Telegram notification failed: ${res.status} ${res.statusText}`;
    if (sentryEnabled) Sentry.captureMessage(message, { level: "warning" });
    return false;
  }
  return true;
}

export async function closeObservability(timeoutMs = 2000) {
  if (sentryEnabled) await Sentry.close(timeoutMs);
}
