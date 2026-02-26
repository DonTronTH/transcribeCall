const fs = require("fs");
const path = require("path");

function readTextIfExists(p) {
  if (!fs.existsSync(p)) return "";
  return fs.readFileSync(p, "utf8").toString().trim();
}

function readJsonIfExists(p) {
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8").toString();
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function escapeHtml(s) {
  return (s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtDateTimeFromStat(stat) {
  // Simple local datetime string
  const d = stat && stat.mtime ? stat.mtime : new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function getCallerReceiverFromMeta(meta) {
  // New format
  if (meta && meta.caller && meta.receiver) {
    return {
      callerName: meta.caller.name || "Unknown",
      callerCompany: meta.caller.company || "Unknown",
      receiverName: meta.receiver.name || "Unknown",
      receiverCompany: meta.receiver.company || "Unknown",
    };
  }

  // Legacy format fallback
  return {
    callerName: (meta && meta.from_name) || "Unknown",
    callerCompany: (meta && meta.from_company) || "Unknown",
    receiverName: (meta && meta.to_name) || "Unknown",
    receiverCompany: (meta && meta.to_company) || "Unknown",
  };
}

function shouldDropTranscriptLine(text) {
  const t = String(text || "").trim();
  if (!t) return true;

  // Drop the prompt-instruction leakage (this is not conversation)
  // You can add more patterns here later if needed.
  if (t.toLowerCase().includes("hvis lyd er dårlig, gæt ikke")) return true;

  return false;
}

function buildTranscriptChatHtml(transcriptText, meta) {
  const { callerName, receiverName } = getCallerReceiverFromMeta(meta || {});
  const caller = String(callerName || "").trim();
  const receiver = String(receiverName || "").trim();

  const lines = String(transcriptText || "")
    .split(/\r?\n+/)
    .map((x) => x.trim())
    .filter(Boolean);

  // Parse "Name: text" format
  const msgs = [];
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;

    const speaker = line.slice(0, idx).trim();
    const text = line.slice(idx + 1).trim();

    if (shouldDropTranscriptLine(text)) continue;

    // Ignore exact duplicates in a row (same speaker + same text)
    const last = msgs[msgs.length - 1];
    if (last && last.speaker === speaker && last.text === text) continue;

    msgs.push({ speaker, text });
  }

  return msgs
    .map((m) => {
      let roleClass = "badge-other";
      if (caller && m.speaker === caller) roleClass = "badge-caller";
      else if (receiver && m.speaker === receiver) roleClass = "badge-receiver";

      return `
<div class="msg">
  <div class="badge ${roleClass}">${escapeHtml(m.speaker)}</div>
  <div class="bubble">${escapeHtml(m.text)}</div>
</div>`.trim();
    })
    .join("\n");
}

function ensureChatCssInjected(html) {
  if (html.includes("/* CHAT_STYLES */")) return html;

  const css = `
<style>
/* CHAT_STYLES */

/* Keep transcript area readable and not stretched across the whole screen */
.chat {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
  max-width: 1100px;
}

/* One row: [badge][bubble] always left aligned */
.msg {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

/* Pills */
.badge {
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  flex: 0 0 auto;
}

/* Colors like your Image 1 */
.badge-caller { background: #ffd6d6; color: #7a1c1c; }
.badge-receiver { background: #d8ffe6; color: #1f6b3a; }
.badge-other { background: #f1f1f1; color: #333; }

/* Bubble next to badge */
.bubble {
  background: #f3f3f3;
  border-radius: 14px;
  padding: 10px 14px;
  line-height: 1.35;
  flex: 1 1 auto;
  max-width: 900px;
}

/* Optional: slightly soften */
.bubble { box-shadow: 0 0 0 0 rgba(0,0,0,0); }
</style>`.trim();

  if (html.includes("</head>"))
    return html.replace("</head>", `${css}\n</head>`);
  return `${css}\n${html}`;
}

async function main() {
  const callsDir = "C:\\git\\transcribeCall\\calls";
  const outDir = path.join(callsDir, "_out");
  const templatePath = path.join(
    "C:\\git\\transcribeCall",
    "renderTemplate.html",
  );

  if (!fs.existsSync(callsDir)) {
    console.log("Calls folder not found:", callsDir);
    process.exit(1);
  }

  if (!fs.existsSync(outDir)) {
    console.log("Out folder not found:", outDir);
    console.log("Expected:", outDir);
    process.exit(1);
  }

  if (!fs.existsSync(templatePath)) {
    console.log("Template not found:", templatePath);
    process.exit(1);
  }

  let template = fs.readFileSync(templatePath, "utf8").toString();
  template = ensureChatCssInjected(template);

  const audioFiles = fs.readdirSync(callsDir).filter((f) => {
    const x = f.toLowerCase();
    return x.endsWith(".mp3") || x.endsWith(".m4a") || x.endsWith(".wav");
  });

  if (audioFiles.length === 0) {
    console.log("No audio files found in:", callsDir);
    process.exit(0);
  }

  for (const audioFile of audioFiles) {
    const audioPath = path.join(callsDir, audioFile);
    const baseName = path.parse(audioFile).name;

    const transcriptPath = path.join(outDir, `${baseName}.transcript.txt`);
    const summaryPath = path.join(outDir, `${baseName}.summary.txt`);
    const coachingPath = path.join(outDir, `${baseName}.coaching.txt`);
    const metaPath = path.join(outDir, `${baseName}.meta.json`);
    const htmlOutPath = path.join(outDir, `${baseName}.html`);

    if (
      !fs.existsSync(transcriptPath) ||
      !fs.existsSync(summaryPath) ||
      !fs.existsSync(coachingPath)
    ) {
      console.log("Skipping (missing txt files):", baseName);
      continue;
    }

    const transcriptText = readTextIfExists(transcriptPath);
    const summaryText = readTextIfExists(summaryPath);
    const coachingText = readTextIfExists(coachingPath);

    const stat = fs.statSync(audioPath);
    const defaultDateTime = fmtDateTimeFromStat(stat);

    const meta = readJsonIfExists(metaPath) || {};

    const { callerName, callerCompany, receiverName, receiverCompany } =
      getCallerReceiverFromMeta(meta);

    const callDatetime = meta.call_datetime || defaultDateTime;

    const headerLine = `Phone call between ${callerName} (${callerCompany}) and ${receiverName} (${receiverCompany})`;
    const datetimeLine = `Date/time: ${callDatetime}`;

    const transcriptHtml = buildTranscriptChatHtml(transcriptText, meta);

    let html = template;

    html = html.replaceAll("{{TITLE}}", escapeHtml(baseName));
    html = html.replaceAll("{{HEADER_LINE}}", escapeHtml(headerLine));
    html = html.replaceAll("{{DATETIME_LINE}}", escapeHtml(datetimeLine));
    html = html.replaceAll("{{SUMMARY_TEXT}}", escapeHtml(summaryText));
    html = html.replaceAll("{{COACHING_TEXT}}", escapeHtml(coachingText));

    // IMPORTANT: transcriptHtml is already safely escaped per message
    html = html.replaceAll("{{TRANSCRIPT_TEXT}}", transcriptHtml);

    fs.writeFileSync(htmlOutPath, html, "utf8");
    console.log("Wrote:", htmlOutPath);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
});
