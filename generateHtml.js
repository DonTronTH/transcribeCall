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

  const template = fs.readFileSync(templatePath, "utf8").toString();

  const audioFiles = fs.readdirSync(callsDir).filter((f) => {
    const x = f.toLowerCase();
    return x.endsWith(".mp3") || x.endsWith(".m4a");
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

    const fromName = meta.from_name || "Unknown";
    const fromCompany = meta.from_company || "Unknown";
    const toName = meta.to_name || "Unknown";
    const toCompany = meta.to_company || "Unknown";
    const callDatetime = meta.call_datetime || defaultDateTime;

    const headerLine = `Phone call between ${fromName} (${fromCompany}) and ${toName} (${toCompany})`;
    const datetimeLine = `Date/time: ${callDatetime}`;

    let html = template;
    html = html.replaceAll("{{TITLE}}", escapeHtml(baseName));
    html = html.replaceAll("{{HEADER_LINE}}", escapeHtml(headerLine));
    html = html.replaceAll("{{DATETIME_LINE}}", escapeHtml(datetimeLine));
    html = html.replaceAll("{{SUMMARY_TEXT}}", escapeHtml(summaryText));
    html = html.replaceAll("{{COACHING_TEXT}}", escapeHtml(coachingText));
    html = html.replaceAll("{{TRANSCRIPT_TEXT}}", escapeHtml(transcriptText));

    fs.writeFileSync(htmlOutPath, html, "utf8");
    console.log("Wrote:", htmlOutPath);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
});
