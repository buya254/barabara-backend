const express = require("express");
const router = express.Router();
const authenticateJWT = require("../middlewares/auth");

function weatherCodeToText(code) {
  const map = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Light freezing drizzle",
    57: "Dense freezing drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    66: "Light freezing rain",
    67: "Heavy freezing rain",
    71: "Slight snow fall",
    73: "Moderate snow fall",
    75: "Heavy snow fall",
    77: "Snow grains",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail",
  };

  return map[Number(code)] || `Weather code ${code}`;
}

function includesAny(text, words) {
  const lower = String(text || "").toLowerCase();
  return words.some((word) => lower.includes(word));
}

function deriveRoadWorkImpact(weather) {
  const condition = String(weather.condition || "").toLowerCase();
  const precipitationMm = Number(weather.precipitationMm || 0);
  const rainMm = Number(weather.rainMm || 0);
  const showersMm = Number(weather.showersMm || 0);
  const windSpeedKph = Number(weather.windSpeedKph || 0);

  const wetWeather =
    precipitationMm > 0 ||
    rainMm > 0 ||
    showersMm > 0 ||
    includesAny(condition, ["rain", "shower", "drizzle", "thunderstorm", "storm"]);

  if (wetWeather) {
    return {
      surfaceCondition: "Wet / rain recorded",
      workImpact:
        "Rain or wet surface recorded. Asphalt/hot mix works should be avoided or suspended unless the Engineer confirms conditions are suitable.",
    };
  }

  if (windSpeedKph >= 30) {
    return {
      surfaceCondition: "Dry / windy",
      workImpact:
        "Strong wind recorded. Monitor dust control, signage, lifting operations and material handling.",
    };
  }

  return {
    surfaceCondition: "No major weather restriction recorded",
    workImpact:
      "No major weather restriction recorded. Works may proceed subject to actual site condition and Engineer instructions.",
  };
}

router.post("/current", authenticateJWT, async (req, res) => {
  try {
    const latitude = Number(req.body.latitude);
    const longitude = Number(req.body.longitude);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({
        message: "Valid latitude and longitude are required.",
      });
    }

    const url = new URL("https://api.open-meteo.com/v1/forecast");

    url.searchParams.set("latitude", String(latitude));
    url.searchParams.set("longitude", String(longitude));
    url.searchParams.set(
      "current",
      [
        "temperature_2m",
        "relative_humidity_2m",
        "apparent_temperature",
        "precipitation",
        "rain",
        "showers",
        "weather_code",
        "cloud_cover",
        "wind_speed_10m",
        "wind_direction_10m",
      ].join(",")
    );
    url.searchParams.set("wind_speed_unit", "kmh");
    url.searchParams.set("timezone", "auto");

    let openMeteoRes = await fetch(url.toString());

if (!openMeteoRes.ok) {
  const firstText = await openMeteoRes.text();
  console.error("Open-Meteo API first attempt error:", openMeteoRes.status, firstText);

  // Fallback attempt: same request, but with UTC timezone.
  url.searchParams.set("timezone", "UTC");

  openMeteoRes = await fetch(url.toString());

  if (!openMeteoRes.ok) {
    const secondText = await openMeteoRes.text();
    console.error("Open-Meteo API fallback error:", openMeteoRes.status, secondText);

    return res.status(502).json({
      message:
        "Weather provider is temporarily unavailable. Please try again, or enter weather manually.",
    });
  }
}

const data = await openMeteoRes.json();
    const current = data.current || {};

    const condition = weatherCodeToText(current.weather_code);

    const mapped = {
    source: "OPEN_METEO_GPS",
    geoPermission: "GRANTED",
    latitude,
    longitude,
    locationLabel: `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
    capturedAt: new Date().toISOString(),

      condition,
      temperatureC: current.temperature_2m ?? null,
      feelsLikeC: current.apparent_temperature ?? null,
      humidity: current.relative_humidity_2m ?? null,

      // Open-Meteo gives actual precipitation/rain amount, not probability, in current conditions.
      precipitationProbability: null,
      precipitationMm: current.precipitation ?? null,
      rainMm: current.rain ?? null,
      showersMm: current.showers ?? null,

      windSpeedKph: current.wind_speed_10m ?? null,
      windDirection: current.wind_direction_10m ?? null,
      cloudCover: current.cloud_cover ?? null,

      rawProvider: "Open-Meteo",
    };

    const impact = deriveRoadWorkImpact(mapped);

    return res.json({
      success: true,
      weather: {
        ...mapped,
        ...impact,
      },
    });
  } catch (err) {
    console.error("Weather route error:", err);

    return res.status(500).json({
      message: "Failed to get weather. Check backend terminal.",
    });
  }
});

module.exports = router;