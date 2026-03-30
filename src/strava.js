/**
 * Strava API client
 * Handles token refresh and fetching activities
 */

const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_API_BASE = "https://www.strava.com/api/v3";

export async function getAccessToken() {
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: process.env.STRAVA_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new Error(`Strava token refresh failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.access_token;
}

async function fetchActivities(accessToken, after, before) {
  const activities = [];
  let page = 1;

  while (true) {
    const res = await fetch(
      `${STRAVA_API_BASE}/athlete/activities?after=${after}&before=${before}&per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!res.ok) {
      throw new Error(`Failed to fetch Strava activities: ${res.status} ${await res.text()}`);
    }

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

// Fetch activities since a given ISO date string (or daysBack as fallback)
export async function getActivitiesSince(sinceIso) {
  const accessToken = await getAccessToken();
  const now = Math.floor(Date.now() / 1000);
  const after = Math.floor(new Date(sinceIso).getTime() / 1000);
  return fetchActivities(accessToken, after, now);
}

// Used only by the bootstrap script
export async function getActivities(daysBack = 90) {
  const accessToken = await getAccessToken();
  const now = Math.floor(Date.now() / 1000);
  const after = now - daysBack * 24 * 60 * 60;
  return fetchActivities(accessToken, after, now);
}
