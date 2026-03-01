require("dotenv").config({ quiet: true });
const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const sql = require("mssql");

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
const VoiceResponse = twilio.twiml.VoiceResponse;

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

//==============================================================
// Twilio Configuration
//==============================================================
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const API_KEY = process.env.TWILIO_API_KEY;
const API_SECRET = process.env.TWILIO_API_SECRET;
const TWIML_APP_SID = process.env.TWILIO_TWIML_APP_SID;
const CALLER_ID = process.env.TWILIO_PHONE_NUMBER;

//==============================================================
// MSSQL Configuration
//==============================================================
const MSSQL_HOST = process.env.MSSQL_HOST;
const MSSQL_PORT = Number(process.env.MSSQL_PORT || 1433);
const MSSQL_DATABASE = process.env.MSSQL_DATABASE;
const MSSQL_USER = process.env.MSSQL_USER;
const MSSQL_PASSWORD = process.env.MSSQL_PASSWORD;
const MSSQL_ENCRYPT =
  String(process.env.MSSQL_ENCRYPT || "false").toLowerCase() === "true";
const MSSQL_TRUST_CERT =
  String(process.env.MSSQL_TRUST_CERT || "false").toLowerCase() === "true";

// Optional: cookie name override (default matches dbo.Users.SessionId usage)
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "SessionId";

//==============================================================
// In-Memory Session Store (temporary)
// Correlates call-status/recording callbacks to session context.
// Replace with DB later if needed.
//==============================================================
const sessions = new Map();

//==============================================================
// MSSQL Connection Pool
//==============================================================
let mssqlPool = null;

async function getMssqlPool() {
  if (mssqlPool) return mssqlPool;

  const config = {
    user: MSSQL_USER,
    password: MSSQL_PASSWORD,
    server: MSSQL_HOST,
    port: MSSQL_PORT,
    database: MSSQL_DATABASE,
    options: {
      encrypt: MSSQL_ENCRYPT,
      trustServerCertificate: MSSQL_TRUST_CERT,
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  };

  mssqlPool = await sql.connect(config);
  return mssqlPool;
}

//==============================================================
// Auth Helpers (cookie -> dbo.Users.SessionId)
//==============================================================
function getCookieValue(req, name) {
  // fallback: raw Cookie header parse (in case cookie-parser isn't behaving)
  const raw =
    req.headers && req.headers.cookie ? String(req.headers.cookie) : "";
  if (!raw) return null;

  const parts = raw.split(";").map((p) => p.trim());
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx === -1) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (k === name) return decodeURIComponent(v);
  }
  return null;
}

function getAuthSessionId(req) {
  // Primary cookie name
  const direct = getCookieValue(req, AUTH_COOKIE_NAME);
  if (direct) return direct;

  // Common alternatives (kept permissive to reduce “why the fuck is it 401” during dev)
  return (
    getCookieValue(req, "sessionId") ||
    getCookieValue(req, "sessionid") ||
    getCookieValue(req, "SessionID") ||
    null
  );
}

async function getAuthUserBySessionId(sessionId) {
  const pool = await getMssqlPool();

  const result = await pool
    .request()
    .input("sessionId", sql.NVarChar(sql.MAX), sessionId).query(`
      SELECT TOP 1
        u.Id,
        u.Firstname,
        u.Lastname,
        u.Email,
        u.PhoneNumber,
        u.CustomerId,
        u.SessionId
      FROM dbo.Users u
      WHERE u.SessionId = @sessionId
    `);

  return result.recordset && result.recordset[0] ? result.recordset[0] : null;
}

//==============================================================
// Utility Functions
//==============================================================
function generateSessionId() {
  return "sess_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
}

function normalizeEmpty(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  return t.length ? t : null;
}

//==============================================================
// 1. ACCESS TOKEN GENERATOR
// NOTE: Frontend calls /api/token with credentials: "include"
// LIVE: validate auth via cookie/session server-side.
// DEV: you may allow bypass via ?identity=... only in development.
//==============================================================
app.get("/api/token", async (req, res) => {
  try {
    const sessionId = getAuthSessionId(req);

    // DEV bypass (only if explicitly in development)
    const devIdentity = req.query.identity;

    let identity = null;

    if (sessionId) {
      const user = await getAuthUserBySessionId(sessionId);
      if (user && user.Id) {
        identity = String(user.Id);
      }
    }

    if (!identity) {
      if (process.env.NODE_ENV === "development" && devIdentity) {
        identity = String(devIdentity);
      } else {
        return res.status(401).json({ error: "Not logged in / unauthorized" });
      }
    }

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: TWIML_APP_SID,
      incomingAllow: false,
    });

    const token = new AccessToken(ACCOUNT_SID, API_KEY, API_SECRET, {
      identity: identity,
    });

    token.addGrant(voiceGrant);

    res.json({
      token: token.toJwt(),
      identity: identity,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Token generation failed" });
  }
});

//==============================================================
// 2. CREATE DIALER SESSION (UI calls with user_id + lead_id + contact_id)
// Contract (frontend):
//   /api/dialer/session?user_id=U&lead_id=L&contact_id=C
//
// IMPORTANT:
// - LIVE: ignore/validate user_id against auth from cookie
// - DEV: can allow user_id bypass when NODE_ENV=development
//
// Returns session JSON used by dialog.html:
//   from_name, from_company, from_phoneno
//   to_name, to_company, to_phoneno (+ to_phone/to_mobile for UI choice)
//   dialer_session_id (optional but useful for correlating callbacks)
//==============================================================
app.get("/api/dialer/session", async (req, res) => {
  const user_id_qs = req.query.user_id; // may be ignored in LIVE
  const lead_id_qs = req.query.lead_id;
  const contact_id_qs = req.query.contact_id;

  if (!lead_id_qs || !contact_id_qs) {
    return res.status(400).json({ error: "Missing lead_id or contact_id" });
  }

  // Parse & validate types
  const lead_id = Number(lead_id_qs);
  const contact_id = Number(contact_id_qs);

  if (!Number.isFinite(lead_id) || lead_id <= 0) {
    return res.status(400).json({ error: "Invalid lead_id" });
  }
  if (!Number.isFinite(contact_id) || contact_id <= 0) {
    return res.status(400).json({ error: "Invalid contact_id" });
  }

  try {
    // Auth user lookup
    const sessionId = getAuthSessionId(req);

    let authUser = null;

    if (sessionId) {
      authUser = await getAuthUserBySessionId(sessionId);
    }

    // DEV bypass: allow using user_id from query string (only in development)
    if (!authUser) {
      if (process.env.NODE_ENV === "development" && user_id_qs) {
        // Look up by Id for DEV only
        const pool = await getMssqlPool();
        const r = await pool
          .request()
          .input("userId", sql.Int, Number(user_id_qs)).query(`
            SELECT TOP 1
              u.Id,
              u.Firstname,
              u.Lastname,
              u.Email,
              u.PhoneNumber,
              u.CustomerId
            FROM dbo.Users u
            WHERE u.Id = @userId
          `);
        authUser = r.recordset && r.recordset[0] ? r.recordset[0] : null;
      } else {
        return res.status(401).json({ error: "Not logged in / unauthorized" });
      }
    }

    // LIVE validation: if user_id is provided, ensure it matches authenticated user
    if (user_id_qs && String(authUser.Id) !== String(user_id_qs)) {
      // In LIVE, you said you want to match cookie identity to user record.
      // This is that guard.
      return res
        .status(403)
        .json({ error: "user_id does not match authenticated user" });
    }

    const pool = await getMssqlPool();

    // Pull everything for the session in one query (verified joins)
    const result = await pool
      .request()
      .input("auth_user_id", sql.Int, Number(authUser.Id))
      .input("lead_id", sql.BigInt, lead_id_qs) // BigInt safe input as string
      .input("contact_id", sql.Int, contact_id).query(`
        SELECT
          -- FROM (meeting booker)
          CONCAT(u.Firstname, ' ', u.Lastname) AS from_name,
          cu.CompanyName                        AS from_company,
          NULLIF(u.PhoneNumber, '')             AS from_phoneno,

          -- TO (contact)
          NULLIF(cp.Name, '')                   AS to_name,
          l.CompanyName                         AS to_company,
          COALESCE(NULLIF(cp.Mobile, ''), NULLIF(cp.Phone, '')) AS to_phoneno,
          NULLIF(cp.Phone, '')                  AS to_phone,
          NULLIF(cp.Mobile, '')                 AS to_mobile

        FROM dbo.Users u
        LEFT JOIN dbo.Customers cu
          ON cu.CvrNumber = u.CustomerId

        JOIN dbo.ContactPersons cp
          ON cp.Id = @contact_id

        JOIN dbo.EnrichedLeads el
          ON el.CVR_Number = cp.EnrichedLead_CVR_Number

        JOIN dbo.Leads l
          ON l.CVR_Number = el.CVR_Number

        WHERE u.Id = @auth_user_id
          AND l.CVR_Number = @lead_id
          AND cp.EnrichedLead_CVR_Number = @lead_id
      `);

    if (!result.recordset || !result.recordset[0]) {
      return res
        .status(404)
        .json({ error: "No session data found for lead_id/contact_id" });
    }

    const row = result.recordset[0];

    // Optional correlation id for Twilio callbacks
    const dialer_session_id = generateSessionId();

    const sessionData = {
      dialer_session_id,
      // echo IDs (handy for debugging; frontend ignores if not used)
      user_id: Number(authUser.Id),
      lead_id: lead_id_qs,
      contact_id: contact_id_qs,

      from_name: normalizeEmpty(row.from_name),
      from_company: normalizeEmpty(row.from_company),
      from_phoneno: normalizeEmpty(row.from_phoneno),

      to_name: normalizeEmpty(row.to_name),
      to_company: normalizeEmpty(row.to_company),
      to_phoneno: normalizeEmpty(row.to_phoneno),
      to_phone: normalizeEmpty(row.to_phone),
      to_mobile: normalizeEmpty(row.to_mobile),

      created_at: new Date().toISOString(),
    };

    // Store minimal context for webhook correlation (temporary in-memory)
    sessions.set(dialer_session_id, sessionData);

    res.json(sessionData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Session creation failed" });
  }
});

//==============================================================
// 3. TwiML Processor
// Twilio hits this for outgoing calls (Twilio TwiML App Voice URL).
// Frontend passes params to device.connect({ params }) and Twilio forwards them.
//==============================================================
app.post("/api/voice-response", (req, res) => {
  const twiml = new VoiceResponse();

  const to = req.body.To;
  const shouldRecord = req.body.ShouldRecord === "true";

  // Correlation + context from frontend (sent in params)
  const dialerSessionId = req.body.DialerSessionId || req.body.SessionId || "";
  const userId = req.body.UserId || "";
  const leadId = req.body.LeadId || "";
  const contactId = req.body.ContactId || "";
  const notes = req.body.Notes || "";

  // Keep a copy (if session exists) so call-status/recording can persist context
  if (dialerSessionId) {
    const existing = sessions.get(dialerSessionId);
    if (existing) {
      existing.user_id = existing.user_id || userId;
      existing.lead_id = existing.lead_id || leadId;
      existing.contact_id = existing.contact_id || contactId;
      existing.notes = notes;
      existing.should_record = shouldRecord;
      sessions.set(dialerSessionId, existing);
    }
  }

  if (to && to !== CALLER_ID) {
    const dialOptions = {
      callerId: CALLER_ID,
      answerOnBridge: true,

      // include correlation in querystring so callbacks can always see it
      action: dialerSessionId
        ? `/api/call-status?dsid=${encodeURIComponent(dialerSessionId)}`
        : "/api/call-status",
    };

    if (shouldRecord) {
      dialOptions.record = "record-from-ringing";
      dialOptions.recordingStatusCallback = dialerSessionId
        ? `/api/recording-finished?dsid=${encodeURIComponent(dialerSessionId)}`
        : "/api/recording-finished";
      dialOptions.recordingStatusCallbackEvent = ["completed"];
    }

    const dial = twiml.dial(dialOptions);

    if (/^[\d\+\-\(\) ]+$/.test(to)) {
      dial.number(to);
    } else {
      dial.client(to);
    }
  } else {
    twiml.say("Invalid call request.");
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

//==============================================================
// 4. Recording Webhook
//==============================================================
app.post("/api/recording-finished", async (req, res) => {
  const recordingUrl = req.body.RecordingUrl;
  const callSid = req.body.CallSid;

  const dialerSessionId =
    req.query.dsid || req.body.DialerSessionId || req.body.SessionId;

  console.log("Recording finished:", callSid);

  if (dialerSessionId && sessions.has(dialerSessionId)) {
    const session = sessions.get(dialerSessionId);
    session.recording_url = recordingUrl;
    sessions.set(dialerSessionId, session);
  }

  res.sendStatus(200);
});

//==============================================================
// 5. Call Status Webhook
//==============================================================
app.post("/api/call-status", async (req, res) => {
  const callStatus = req.body.CallStatus;
  const callSid = req.body.CallSid;
  const duration = req.body.CallDuration;

  const dialerSessionId =
    req.query.dsid || req.body.DialerSessionId || req.body.SessionId;

  console.log("Call status:", callStatus);

  if (
    callStatus === "completed" &&
    dialerSessionId &&
    sessions.has(dialerSessionId)
  ) {
    const session = sessions.get(dialerSessionId);

    session.call_sid = callSid;
    session.duration_seconds = duration ? Number(duration) : null;
    session.completed_at = new Date().toISOString();

    try {
      await saveCallToMSSQL(session);
    } catch (err) {
      console.error("saveCallToMSSQL failed:", err);
      // keep session for debugging rather than deleting immediately
      // sessions.delete(dialerSessionId);
      res.sendStatus(200);
      return;
    }

    sessions.delete(dialerSessionId);
  }

  res.sendStatus(200);
});

//==============================================================
// MSSQL SAVE FUNCTION (STUB)
// Replace with a real INSERT into your existing 24Sales call log table.
//==============================================================
async function saveCallToMSSQL(sessionData) {
  // TODO: Insert into existing 24Sales call log table (unknown table/columns right now)
  console.log("Saving call to MSSQL:", sessionData);

  // Example skeleton (DO NOT ENABLE until you provide the target table schema):
  //
  // const pool = await getMssqlPool();
  // await pool.request()
  //   .input("user_id", sql.Int, Number(sessionData.user_id))
  //   .input("lead_id", sql.BigInt, String(sessionData.lead_id))
  //   .input("contact_id", sql.Int, Number(sessionData.contact_id))
  //   .input("call_sid", sql.NVarChar(64), sessionData.call_sid)
  //   .input("duration_seconds", sql.Int, sessionData.duration_seconds || 0)
  //   .input("recording_url", sql.NVarChar(sql.MAX), sessionData.recording_url || null)
  //   .input("notes", sql.NVarChar(sql.MAX), sessionData.notes || null)
  //   .query(`INSERT INTO dbo.??? (...) VALUES (...)`);
}

//==============================================================
// Server Start
//==============================================================
app.listen(port, () => {
  console.log(`Dialer server running on port ${port}`);
});
