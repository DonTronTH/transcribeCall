require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
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
// In-Memory Session Store (temporary)
// Replace with DB later if needed
//==============================================================
const sessions = new Map();

//==============================================================
// 1. ACCESS TOKEN GENERATOR
//==============================================================
app.get("/api/token", (req, res) => {
  const identity = req.query.identity;

  if (!identity) {
    return res.status(400).json({ error: "Missing identity" });
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
});

//==============================================================
// 2. CREATE DIALER SESSION (Angular calls with IDs only)
//==============================================================
app.get("/api/dialer/session", async (req, res) => {
  const user_id = req.query.user_id;
  const customer_id = req.query.customer_id;

  if (!user_id || !customer_id) {
    return res.status(400).json({ error: "Missing user_id or customer_id" });
  }

  try {
    const user = await getUserByIdFromMSSQL(user_id);
    const customer = await getCustomerByIdFromMSSQL(customer_id);

    const session_id = generateSessionId();

    const sessionData = {
      session_id,
      user_id,
      customer_id,
      from_name: user.name,
      from_company: user.company,
      from_phoneno: user.phone,
      to_name: customer.name,
      to_company: customer.company,
      to_phoneno: customer.phone,
      created_at: new Date(),
    };

    sessions.set(session_id, sessionData);

    res.json(sessionData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Session creation failed" });
  }
});

//==============================================================
// 3. GET SESSION BY ID (Dialer UI loads this)
//==============================================================
app.get("/api/dialer/session/:sid", (req, res) => {
  const session = sessions.get(req.params.sid);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  res.json(session);
});

//==============================================================
// 4. TwiML Processor
//==============================================================
app.post("/api/voice-response", (req, res) => {
  const twiml = new VoiceResponse();

  const to = req.body.To;
  const shouldRecord = req.body.ShouldRecord === "true";
  const sessionId = req.body.SessionId;

  if (to && to !== CALLER_ID) {
    const dialOptions = {
      callerId: CALLER_ID,
      answerOnBridge: true,
      action: "/api/call-status",
    };

    if (shouldRecord) {
      dialOptions.record = "record-from-ringing";
      dialOptions.recordingStatusCallback = "/api/recording-finished";
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
// 5. Recording Webhook
//==============================================================
app.post("/api/recording-finished", async (req, res) => {
  const recordingUrl = req.body.RecordingUrl;
  const callSid = req.body.CallSid;
  const sessionId = req.body.SessionId;

  console.log("Recording finished:", callSid);

  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    session.recording_url = recordingUrl;
    sessions.set(sessionId, session);
  }

  res.sendStatus(200);
});

//==============================================================
// 6. Call Status Webhook
//==============================================================
app.post("/api/call-status", async (req, res) => {
  const callStatus = req.body.CallStatus;
  const callSid = req.body.CallSid;
  const duration = req.body.CallDuration;
  const sessionId = req.body.SessionId;

  console.log("Call status:", callStatus);

  if (callStatus === "completed" && sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);

    session.call_sid = callSid;
    session.duration_seconds = duration;
    session.completed_at = new Date();

    await saveCallToMSSQL(session);

    sessions.delete(sessionId);
  }

  res.sendStatus(200);
});

//==============================================================
// Utility Functions
//==============================================================

function generateSessionId() {
  return "sess_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
}

//==============================================================
// MSSQL LOOKUP FUNCTIONS (STUBS)
// Replace when table definitions are ready
//==============================================================

async function getUserByIdFromMSSQL(user_id) {
  // TODO: Replace with real MSSQL query
  return {
    id: user_id,
    name: "Sales User",
    company: "24Sales",
    phone: CALLER_ID,
  };
}

async function getCustomerByIdFromMSSQL(customer_id) {
  // TODO: Replace with real MSSQL query
  return {
    id: customer_id,
    name: "Customer Name",
    company: "Customer Company",
    phone: "+4512345678",
  };
}

async function saveCallToMSSQL(sessionData) {
  // TODO: Insert into existing 24Sales call log table
  console.log("Saving call to MSSQL:", sessionData);
}

//==============================================================
// Server Start
//==============================================================
app.listen(port, () => {
  console.log(`Dialer server running on port ${port}`);
});
