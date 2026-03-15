const express = require("express");
const dotenv = require("dotenv");
const axios = require("axios");

dotenv.config();

const app = express();
app.use(express.json());

const TERRA_API_KEY = process.env.TERRA_API_KEY;
const TERRA_DEV_ID = process.env.TERRA_DEV_ID;
const PORT = process.env.PORT || 3000;

// In-memory store (replace with Supabase later)
const userHealthData = {};

// ─── MOCK DATA (fallback if no Terra data yet) ───
const getMockData = (userId) => ({
  user_id: userId,
  source: "mock",
  sleep_score: 99,
  readiness_score: 84,
  hrv_ms: 58,
  resting_hr: 52,
  steps: 8241,
  active_calories: 520,
  sleep_duration_min: 432,
  deep_sleep_min: 108,
  rem_sleep_min: 88,
  stress_level: 2.1,
  vo2_max: 52.4,
  last_updated: new Date().toISOString(),
});

// ─── NORMALIZE Terra data to HUB schema ───
const normalizeTerraData = (type, data, userId) => {
  const existing = userHealthData[userId] || getMockData(userId);

  if (type === "sleep" && data.length > 0) {
    const sleep = data[0];
    return {
      ...existing,
      source: "terra",
      sleep_score: sleep.sleep_durations_data?.sleep_efficiency
        ? Math.round(sleep.sleep_durations_data.sleep_efficiency * 100)
        : existing.sleep_score,
      sleep_duration_min: sleep.sleep_durations_data?.total_sleep_duration
        ? Math.round(sleep.sleep_durations_data.total_sleep_duration / 60)
        : existing.sleep_duration_min,
      deep_sleep_min: sleep.sleep_durations_data?.deep_sleep_duration
        ? Math.round(sleep.sleep_durations_data.deep_sleep_duration / 60)
        : existing.deep_sleep_min,
      rem_sleep_min: sleep.sleep_durations_data?.rem_sleep_duration
        ? Math.round(sleep.sleep_durations_data.rem_sleep_duration / 60)
        : existing.rem_sleep_min,
      hrv_ms: sleep.heart_rate_data?.hrv?.avg_hrv
        ? Math.round(sleep.heart_rate_data.hrv.avg_hrv)
        : existing.hrv_ms,
      last_updated: new Date().toISOString(),
    };
  }

  if (type === "daily" && data.length > 0) {
    const daily = data[0];
    return {
      ...existing,
      source: "terra",
      steps: daily.distance_data?.steps ?? existing.steps,
      active_calories: daily.calories_data?.total_burned_calories
        ? Math.round(daily.calories_data.total_burned_calories)
        : existing.active_calories,
      resting_hr: daily.heart_rate_data?.resting_hr_bpm ?? existing.resting_hr,
      stress_level: daily.stress_data?.stress_duration_seconds
        ? parseFloat((daily.stress_data.stress_duration_seconds / 3600).toFixed(1))
        : existing.stress_level,
      last_updated: new Date().toISOString(),
    };
  }

  if (type === "activity" && data.length > 0) {
    const activity = data[0];
    return {
      ...existing,
      source: "terra",
      active_calories: activity.calories_data?.total_burned_calories
        ? Math.round(activity.calories_data.total_burned_calories)
        : existing.active_calories,
      last_updated: new Date().toISOString(),
    };
  }

  return existing;
};

// ─── POST /webhook ───
// Receives Terra webhook events
app.post("/webhook", (req, res) => {
  const payload = req.body;

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📡 Terra Webhook received");
  console.log("Type:", payload.type);
  console.log("User:", payload.user?.user_id);
  console.log("Data count:", payload.data?.length ?? 0);
  console.log("Full payload:", JSON.stringify(payload, null, 2));
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const { type, user, data } = payload;

  if (!user?.user_id || !type || !data) {
    return res.status(400).json({ error: "Invalid webhook payload" });
  }

  // Normalize and store
  userHealthData[user.user_id] = normalizeTerraData(type, data, user.user_id);

  console.log(`✅ Stored ${type} data for user ${user.user_id}`);
  res.status(200).json({ received: true });
});

// ─── GET /connect/:userId ───
// Generates Terra widget session URL
app.get("/connect/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const response = await axios.post(
      "https://api.tryterra.co/v2/auth/generateWidgetSession",
      {
        reference_id: userId,
        providers: "GARMIN,OURA,WHOOP,APPLE,GOOGLE",
        language: "en",
        auth_success_redirect_url: "hub://connected",
        auth_failure_redirect_url: "hub://failed",
      },
      {
        headers: {
          "x-api-key": TERRA_API_KEY,
          "dev-id": TERRA_DEV_ID,
          "Content-Type": "application/json",
        },
      }
    );

    const { session_id, url } = response.data;

    console.log(`🔗 Widget session created for user ${userId}: ${session_id}`);

    res.json({
      session_id,
      widget_url: url,
      user_id: userId,
    });
  } catch (err) {
    console.error("❌ Terra widget session error:", err.response?.data || err.message);
    res.status(500).json({
      error: "Failed to create Terra widget session",
      details: err.response?.data || err.message,
    });
  }
});

// ─── GET /data/:userId ───
// Returns latest health metrics for a user
app.get("/data/:userId", (req, res) => {
  const { userId } = req.params;

  const data = userHealthData[userId] || getMockData(userId);

  console.log(`📊 Data requested for user ${userId} — source: ${data.source}`);

  res.json(data);
});

// ─── GET /health ───
// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    users_cached: Object.keys(userHealthData).length,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`⚡ HUB Backend running on port ${PORT}`);
  console.log(`Terra Dev ID: ${TERRA_DEV_ID ? "✅ loaded" : "❌ missing"}`);
  console.log(`Terra API Key: ${TERRA_API_KEY ? "✅ loaded" : "❌ missing"}`);
});
