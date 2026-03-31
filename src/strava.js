/**
 * Strava API client — per-user token support
 * All functions accept a refreshToken and return { activities, refreshToken } so callers can persist the rotated token
 */

const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_API_BASE = "https://www.strava.com/api/v3";
const MAX_PAGES = 10;

export async function refreshStravaToken(refreshToken) {
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 && body.includes("invalid")) throw new Error("STRAVA_DEAUTHORIZED");
    throw new Error(`Strava token refresh failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: data.expires_at };
}

async function fetchActivities(accessToken, after, before) {
  const activities = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const res = await fetch(
      `${STRAVA_API_BASE}/athlete/activities?after=${after}&before=${before}&per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) throw new Error(`Failed to fetch Strava activities: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    if (batch.length === 0) break;
    activities.push(...batch);
    page++;
  }

  return activities.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    date: new Date(a.start_date).toDateString(),
    startDateIso: new Date(a.start_date).toISOString(),
    distanceKm: (a.distance / 1000).toFixed(2),
    durationMin: Math.round(a.moving_time / 60),
    avgHeartRate: a.average_heartrate ?? null,
    elevationGain: a.total_elevation_gain ?? 0,
  }));
}

export async function getActivitiesSince(refreshToken, sinceIso) {
  const tokens = await refreshStravaToken(refreshToken);
  const now = Math.floor(Date.now() / 1000);
  const after = Math.floor(new Date(sinceIso).getTime() / 1000);
  const activities = await fetchActivities(tokens.accessToken, after, now);
  return { activities, refreshToken: tokens.refreshToken };
}

export async function getActivities(refreshToken, daysBack = 90) {
  const tokens = await refreshStravaToken(refreshToken);
  const now = Math.floor(Date.now() / 1000);
  const after = now - daysBack * 24 * 60 * 60;
  const activities = await fetchActivities(tokens.accessToken, after, now);
  return { activities, refreshToken: tokens.refreshToken };
}
