const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");
const OpenAI = require("openai");

// Hardcoded call metadata (used for prompts + written to meta.json)
//
// IMPORTANT:
// - We use CALLER/RECEIVER as the only source of truth.
// - We map audio channels to roles so we don't repeat names in multiple places.
// - We still write legacy from_/to_ fields into meta.json for generateHtml.js compatibility.
const callMeta = {
  caller: {
    name_id: "????????",
    name: "Torben Rudgaard",
    company_id: "????????",
    company: "E-Bureauet Philippines",
    phoneno: "123456789",
  },

  receiver: {
    name_id: "????????",
    name: "Carsten Düring",
    company_id: "????????",
    company: "E-Bureauet ApS",
    phoneno: "123456789",
  },

  // Channel mapping for dual-channel recordings:
  // channel_0_role is LEFT  (FFmpeg pan=mono|c0=FL)
  // channel_1_role is RIGHT (FFmpeg pan=mono|c0=FR)
  //
  // If the referat is swapping people, you DO NOT change caller/receiver.
  // You only flip these two roles.
  channel_0_role: "caller", // "caller" or "receiver"
  channel_1_role: "receiver", // "caller" or "receiver"

  call_datetime: "2026-02-12 15:32:05",
  call_minutes: "00:14:58",

  call_file:
    "https://www.twilio.com/console/voice/api/recordings/recording-logs/RE7504da6e1e6c480bd9bdc2ba06326f2b/download/wav?__override_layout__=embed&bifrost=true&x-target-region=us1",
};

// This can be:
// - local file path (mp3/m4a/wav)
// - Twilio console URL (we extract RE... and build API URL)
// - Twilio API recording media URL
// call_file:
//   "https://www.twilio.com/console/voice/api/recordings/recording-logs/REd7df8588ca9eafad049efdfe1b5d15ec/download/mp3?__override_layout__=embed&bifrost=true&x-target-region=us1",
//
// call_file:
//   "https://www.twilio.com/console/voice/api/recordings/recording-logs/RE5ca0cd567801bfa2568a8cae5fb32870/download/wav?__override_layout__=embed&bifrost=true&x-target-region=us1",

function extractRecordingSidFromAnyUrl(s) {
  const m = String(s || "").match(/\/(RE[a-zA-Z0-9]{10,})\b/);
  return m ? m[1] : null;
}

function detectPreferredTwilioExtFromUrl(s) {
  const u = String(s || "").toLowerCase();

  // Twilio Console links often look like .../download/wav?... or .../download/mp3?...
  if (u.includes("/download/wav")) return "wav";
  if (u.includes("/download/mp3")) return "mp3";

  // Direct media URL might end in .wav/.mp3
  if (u.includes(".wav")) return "wav";
  if (u.includes(".mp3")) return "mp3";

  // Default to wav to preserve dual-channel recordings
  return "wav";
}

function buildTwilioApiRecordingUrl(accountSid, recordingSid, ext) {
  const safeExt = String(ext || "wav").toLowerCase() === "mp3" ? "mp3" : "wav";
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.${safeExt}`;
}

function downloadFileWithRedirects(
  url,
  destinationPath,
  authUser,
  authPass,
  redirectCount = 0,
) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(
        new Error("Too many redirects while downloading Twilio recording"),
      );
      return;
    }

    const req = https.request(
      url,
      {
        method: "GET",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(`${authUser}:${authPass}`).toString("base64"),
        },
      },
      (res) => {
        const status = res.statusCode || 0;

        if (status >= 300 && status < 400 && res.headers.location) {
          const nextUrl = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).toString();
          res.resume();
          downloadFileWithRedirects(
            nextUrl,
            destinationPath,
            authUser,
            authPass,
            redirectCount + 1,
          )
            .then(resolve)
            .catch(reject);
          return;
        }

        if (status < 200 || status >= 300) {
          let body = "";
          res.on("data", (d) => (body += d.toString()));
          res.on("end", () => {
            reject(
              new Error(
                `Download failed (${status}). URL: ${url}. Response: ${body.slice(0, 500)}`,
              ),
            );
          });
          return;
        }

        const file = fs.createWriteStream(destinationPath);
        res.pipe(file);

        file.on("finish", () => {
          file.close(() => resolve(destinationPath));
        });

        file.on("error", (err) => {
          try {
            file.close(() => {});
          } catch (e) {}
          reject(err);
        });
      },
    );

    req.on("error", reject);
    req.end();
  });
}

async function ensureAudioInCallsFolder(callsDir, meta) {
  if (!meta.call_file) return null;

  // Local file path
  if (!String(meta.call_file).toLowerCase().startsWith("http")) {
    if (!fs.existsSync(meta.call_file)) {
      console.log("Call file not found:", meta.call_file);
      return null;
    }

    const fileName = path.basename(meta.call_file);
    const destination = path.join(callsDir, fileName);

    if (!fs.existsSync(destination)) {
      fs.copyFileSync(meta.call_file, destination);
      console.log("Copied local audio to:", destination);
    } else {
      console.log("Audio already exists in calls folder:", destination);
    }

    return destination;
  }

  // URL download (Twilio)
  const accountSid = process.env.TWILIO_ACCOUNT_SID || "";
  const authToken = process.env.TWILIO_AUTH_TOKEN || "";

  if (!accountSid || !authToken) {
    console.log("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");
    return null;
  }

  const originalUrl = String(meta.call_file);

  const recSid =
    extractRecordingSidFromAnyUrl(originalUrl) ||
    extractRecordingSidFromAnyUrl(originalUrl);

  if (!recSid) {
    console.log(
      "Could not extract RecordingSid (RE...) from URL:",
      originalUrl,
    );
    return null;
  }

  const preferredExt = detectPreferredTwilioExtFromUrl(originalUrl);

  // If it's already a direct Twilio API media URL, keep it (but we still set destination ext from preferredExt)
  const isTwilioApiMediaUrl = originalUrl.includes(
    "api.twilio.com/2010-04-01/Accounts/",
  );

  const primaryDownloadUrl = isTwilioApiMediaUrl
    ? originalUrl
    : buildTwilioApiRecordingUrl(accountSid, recSid, preferredExt);

  const destinationPrimary = path.join(callsDir, `${recSid}.${preferredExt}`);

  if (fs.existsSync(destinationPrimary)) {
    console.log("Twilio recording already downloaded:", destinationPrimary);
    return destinationPrimary;
  }

  console.log("Downloading Twilio recording...");
  console.log("From:", primaryDownloadUrl);
  console.log("To:", destinationPrimary);

  try {
    await downloadFileWithRedirects(
      primaryDownloadUrl,
      destinationPrimary,
      accountSid,
      authToken,
    );
    console.log("Downloaded:", destinationPrimary);
    return destinationPrimary;
  } catch (err) {
    // Optional fallback: if wav fails, try mp3 (mp3 won't support left/right split)
    if (preferredExt === "wav") {
      const fallbackExt = "mp3";
      const fallbackUrl = buildTwilioApiRecordingUrl(
        accountSid,
        recSid,
        fallbackExt,
      );
      const destinationFallback = path.join(
        callsDir,
        `${recSid}.${fallbackExt}`,
      );

      if (fs.existsSync(destinationFallback)) {
        console.log("Twilio mp3 already downloaded:", destinationFallback);
        console.log("Warning: MP3 is mono/mixed; no speaker split possible.");
        return destinationFallback;
      }

      console.log("WAV download failed, falling back to MP3.");
      console.log("From:", fallbackUrl);
      console.log("To:", destinationFallback);

      await downloadFileWithRedirects(
        fallbackUrl,
        destinationFallback,
        accountSid,
        authToken,
      );

      console.log("Downloaded:", destinationFallback);
      console.log("Warning: MP3 is mono/mixed; no speaker split possible.");
      return destinationFallback;
    }

    throw err;
  }
}

function ensureFfmpegExists() {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    return true;
  } catch (e) {
    return false;
  }
}

function ensureFfprobeExists() {
  try {
    execSync("ffprobe -version", { stdio: "ignore" });
    return true;
  } catch (e) {
    return false;
  }
}

function getAudioChannels(inputAudioPath) {
  if (!ensureFfprobeExists()) return null;

  try {
    const cmd =
      `ffprobe -v error -select_streams a:0 ` +
      `-show_entries stream=channels ` +
      `-of default=nw=1:nk=1 "${inputAudioPath}"`;
    const out = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    return null;
  }
}

function splitStereoToMonoWav(inputAudioPath, outDir, baseName) {
  if (!ensureFfmpegExists()) {
    throw new Error(
      "ffmpeg not found. Install ffmpeg and ensure it is in PATH. Then retry.",
    );
  }

  const tmpDir = path.join(outDir, "_tmp");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const ch0Path = path.join(tmpDir, `${baseName}.ch0.wav`);
  const ch1Path = path.join(tmpDir, `${baseName}.ch1.wav`);

  // Split stereo into two mono wavs using pan (more reliable than -map_channel)
  const cmd0 = `ffmpeg -y -i "${inputAudioPath}" -af "pan=mono|c0=FL" "${ch0Path}"`;
  const cmd1 = `ffmpeg -y -i "${inputAudioPath}" -af "pan=mono|c0=FR" "${ch1Path}"`;

  execSync(cmd0, { stdio: "ignore" });
  execSync(cmd1, { stdio: "ignore" });

  if (!fs.existsSync(ch0Path) || !fs.existsSync(ch1Path)) {
    throw new Error("Channel split failed: expected two mono wav outputs.");
  }

  return { ch0Path, ch1Path };
}

async function transcribeVerboseJson(client, audioPath, prompt) {
  // We want segments for speaker merging.
  // gpt-4o-transcribe currently rejects verbose_json in your account.
  // whisper-1 supports verbose_json with segments.
  const tr = await client.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: "whisper-1",
    language: "da",
    prompt,
    response_format: "verbose_json",
  });

  return tr || {};
}

function normalizeSegments(tr) {
  const segs = tr && tr.segments ? tr.segments : [];
  return Array.isArray(segs)
    ? segs
        .map((x) => ({
          start: typeof x.start === "number" ? x.start : 0,
          end: typeof x.end === "number" ? x.end : 0,
          text: String(x.text || "").trim(),
        }))
        .filter((x) => x.text)
    : [];
}

function mergeByStartTime(segmentsA, speakerA, segmentsB, speakerB) {
  const merged = [];
  for (const s of segmentsA) merged.push({ ...s, speaker: speakerA });
  for (const s of segmentsB) merged.push({ ...s, speaker: speakerB });

  merged.sort((a, b) => (a.start || 0) - (b.start || 0));

  // Output as lines: Speaker: text
  const lines = [];
  for (const m of merged) {
    const chunks = String(m.text || "")
      .split(/\r?\n+/)
      .map((x) => String(x || "").trim())
      .filter(Boolean);

    if (!chunks.length) continue;

    for (const t of chunks) {
      lines.push(`${m.speaker}: ${t}`);
    }
  }

  return lines.join("\n");
}

function roleToPerson(meta, role) {
  const r = String(role || "").toLowerCase();
  if (r === "caller") return meta.caller || null;
  if (r === "receiver") return meta.receiver || null;
  return null;
}

function buildLegacyMeta(meta) {
  const caller = meta.caller || {};
  const receiver = meta.receiver || {};
  const p0 = roleToPerson(meta, meta.channel_0_role) || {};
  const p1 = roleToPerson(meta, meta.channel_1_role) || {};

  // We keep both:
  // - new caller/receiver structure
  // - legacy from_/to_ + channel_*_speaker fields for compatibility/clarity
  return {
    ...meta,

    // Legacy naming (generateHtml.js expects these keys today)
    from_name_id: caller.name_id,
    from_name: caller.name,
    from_company_id: caller.company_id,
    from_company: caller.company,
    from_phoneno: caller.phoneno,

    to_name_id: receiver.name_id,
    to_name: receiver.name,
    to_company_id: receiver.company_id,
    to_company: receiver.company,
    to_phoneno: receiver.phoneno,

    // Explicit speaker labels derived from roles
    channel_0_speaker: p0.name,
    channel_1_speaker: p1.name,
  };
}

async function main() {
  const projectRoot = "C:\\git\\transcribeCall";
  const callsDir = path.join(projectRoot, "calls");
  const outDir = path.join(callsDir, "_out");

  if (!fs.existsSync(callsDir)) {
    console.log("Calls folder not found:", callsDir);
    process.exit(1);
  }

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  if (!process.env.OPENAI_API_KEY) {
    console.log("Missing OPENAI_API_KEY");
    process.exit(1);
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Download/copy into calls folder
  const audioPath = await ensureAudioInCallsFolder(callsDir, callMeta);
  if (!audioPath) {
    console.log("No valid audio file to transcribe.");
    process.exit(1);
  }

  const baseName = path.parse(audioPath).name;

  const transcriptPath = path.join(outDir, `${baseName}.transcript.txt`);
  const summaryPath = path.join(outDir, `${baseName}.summary.txt`);
  const coachingPath = path.join(outDir, `${baseName}.coaching.txt`);
  const metaPath = path.join(outDir, `${baseName}.meta.json`);

  const metaLine =
    `Opkald meta: ${callMeta.caller.name} (${callMeta.caller.company}) ` +
    `ringede til ${callMeta.receiver.name} (${callMeta.receiver.company}). ` +
    `Tid: ${callMeta.call_datetime}. ` +
    `Varighed: ${callMeta.call_minutes} minutter.`;

  console.log("\n========================================");
  console.log("Processing:", audioPath);
  console.log("========================================\n");

  try {
    const channels = getAudioChannels(audioPath);
    if (channels !== null) {
      console.log("ffprobe channels:", channels);
    } else {
      console.log(
        "ffprobe channels: unknown (ffprobe missing or probe failed)",
      );
    }

    const basePrompt =
      "Dansk telefonsamtale. " +
      metaLine +
      " " +
      "Brug korrekt dansk stavning. Bevar egennavne korrekt, inkl. diakritiske tegn. " +
      "Skriv firmanavne præcist (fx 'ApS' med stort A og S). " +
      "Hvis lyd er dårlig, gæt ikke; skriv [uhørligt] i stedet.";

    let transcriptText = "";

    if (channels === 2) {
      // Split stereo -> mono wavs
      const { ch0Path, ch1Path } = splitStereoToMonoWav(
        audioPath,
        outDir,
        baseName,
      );

      const promptCh0 =
        basePrompt +
        " Dette er KUN én kanal. Skriv kun det, der bliver sagt i denne kanal.";
      const promptCh1 =
        basePrompt +
        " Dette er KUN én kanal. Skriv kun det, der bliver sagt i denne kanal.";

      // Transcribe both channels
      const tr0 = await transcribeVerboseJson(client, ch0Path, promptCh0);
      const tr1 = await transcribeVerboseJson(client, ch1Path, promptCh1);

      const seg0 = normalizeSegments(tr0);
      const seg1 = normalizeSegments(tr1);

      if (seg0.length === 0 && seg1.length === 0) {
        console.log("Empty transcript.");
        process.exit(1);
      }

      const role0 = callMeta.channel_0_role || "caller";
      const role1 = callMeta.channel_1_role || "receiver";

      const person0 = roleToPerson(callMeta, role0);
      const person1 = roleToPerson(callMeta, role1);

      const speaker0 = (person0 && person0.name) || "Speaker 1";
      const speaker1 = (person1 && person1.name) || "Speaker 2";

      transcriptText = mergeByStartTime(seg0, speaker0, seg1, speaker1);
    } else {
      console.log("Warning: input is not 2-channel; skipping speaker split.");

      const tr = await transcribeVerboseJson(
        client,
        audioPath,
        basePrompt + " Skriv hele samtalen i én samlet transskription.",
      );

      const seg = normalizeSegments(tr);
      if (seg.length === 0) {
        console.log("Empty transcript.");
        process.exit(1);
      }

      // In mono/mixed recordings, don't pretend we know who is who.
      const speaker = "Samtale";
      const lines = [];
      for (const s of seg) {
        const chunks = String(s.text || "")
          .split(/\r?\n+/)
          .map((x) => String(x || "").trim())
          .filter(Boolean);

        for (const t of chunks) {
          lines.push(`${speaker}: ${t}`);
        }
      }
      transcriptText = lines.join("\n");
    }

    fs.writeFileSync(transcriptPath, transcriptText + "\n", "utf8");
    console.log("Saved transcript:", transcriptPath);

    // Write meta.json (for generateHtml.js)
    const metaToWrite = buildLegacyMeta(callMeta);
    fs.writeFileSync(
      metaPath,
      JSON.stringify(metaToWrite, null, 2) + "\n",
      "utf8",
    );
    console.log("Saved meta:", metaPath);

    // 2) SUMMARY
    const summaryResp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "Du skriver korte, faktuelle referater på dansk. Maks 10 linjer. " +
            "Fokus: hvad de talte om, behov, indvendinger, beslutninger, næste skridt. " +
            "Brug call-meta konsekvent og korrekt. " +
            "CALLER ringede til RECEIVER.",
        },
        {
          role: "user",
          content:
            metaLine +
            "\n\nLav et referat (maks 10 linjer) af denne samtale:\n\n" +
            transcriptText,
        },
      ],
    });

    const summaryText =
      summaryResp?.choices?.[0]?.message?.content?.trim() || "";

    fs.writeFileSync(summaryPath, summaryText + "\n", "utf8");
    console.log("Saved summary:", summaryPath);

    // 3) COACHING
    const coachingResp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "Du er en streng, praktisk salgstræner på dansk. " +
            "Giv præcis 5 konkrete forbedringer. " +
            "Kort og handlingsorienteret. Brug call-meta korrekt. " +
            "CALLER ringede til RECEIVER.",
        },
        {
          role: "user",
          content:
            metaLine +
            "\n\nGiv 5 konkrete forbedringer til mødebookeren for denne samtale:\n\n" +
            transcriptText,
        },
      ],
    });

    const coachingText =
      coachingResp?.choices?.[0]?.message?.content?.trim() || "";

    fs.writeFileSync(coachingPath, coachingText + "\n", "utf8");
    console.log("Saved coaching:", coachingPath);
  } catch (err) {
    console.error("Error during transcription pipeline:");
    console.error(err?.message || err);
    process.exit(1);
  }

  console.log("\nTranscription phase done.");

  // Generate HTML
  try {
    console.log("Generating HTML...");
    execSync("node generateHtml.js", {
      cwd: projectRoot,
      stdio: "inherit",
    });
  } catch (err) {
    console.error("Failed to generate HTML:", err?.message || err);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
});
