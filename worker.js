const GOOGLE_SHEETS_WEBHOOK =
  "https://script.google.com/macros/s/AKfycbzaodIxKE2CJ4m2s40iurh-JE1XSYBOcCA3Bwq7PwRTS5pzkUNPeWdUW35BK2-20x7J1Q/exec";

export class SensorState {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // =========================================================
    // GET DATA SENSOR
    // =========================================================
    if (
      request.method === "GET" &&
      url.pathname === "/api/sensor"
    ) {
      const data = await this.ctx.storage.get("sensorData");
      const buzzer = await this.ctx.storage.get("buzzerEnabled");

      // Belum pernah menerima data
      if (!data) {
        return jsonResponse({
          online: false,
          db: 0,
          warning: false,
          buzzer: false,
          aktivitas: "-",
          device: null,
          timestamp: null,
          status: "offline"
        });
      }

      // =====================================================
      // ESP32 DIANGGAP OFFLINE JIKA
      // TIDAK ADA DATA SELAMA 5 DETIK
      // =====================================================
      const OFFLINE_TIMEOUT = 5000;
      const lastSeen = Number(data.lastSeen || 0);
      const online =
        lastSeen > 0 &&
        (Date.now() - lastSeen) <= OFFLINE_TIMEOUT;

      // =====================================================
      // OFFLINE
      // =====================================================
      if (!online) {
        return jsonResponse({
          online: false,
          db: 0,
          warning: false,
          buzzer: false,
          aktivitas: "-",
          device: data.device || null,
          timestamp: data.timestamp || null,
          status: "offline"
        });
      }

      // =====================================================
      // ONLINE
      // =====================================================
      return jsonResponse({
        ...data,
        online: true,
        buzzer:
          buzzer !== undefined
            ? buzzer
            : data.buzzer
      });
    }

    // =========================================================
    // KIRIM LOG KE GOOGLE SHEETS (DIPANGGIL CRON TIAP 30 MENIT)
    // =========================================================
    if (
      request.method === "POST" &&
      url.pathname === "/internal/push-sheets"
    ) {
      const data = await this.ctx.storage.get("sensorData");
      const OFFLINE_TIMEOUT = 5000;
      const lastSeen = Number(data?.lastSeen || 0);
      const online =
        lastSeen > 0 &&
        (Date.now() - lastSeen) <= OFFLINE_TIMEOUT;

      // Siapkan payload (jika ESP32 sedang offline, tetap catat status OFFLINE / 0 dB)
      const payload = online
        ? {
            online: true,
            db: Number(data.db) || 0,
            aktivitas: data.aktivitas || data.activity || "-",
            warning: data.warning === true
          }
        : {
            online: false,
            db: 0,
            aktivitas: "OFFLINE",
            warning: false
          };

      try {
        const res = await fetch(GOOGLE_SHEETS_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const text = await res.text();
        return jsonResponse({ success: true, payload, sheetsResponse: text });
      } catch (err) {
        return jsonResponse(
          { success: false, error: err.message },
          500
        );
      }
    }

    // =========================================================
    // SET BUZZER
    // =========================================================
    if (
      request.method === "POST" &&
      url.pathname === "/set-buzzer"
    ) {
      try {
        const body = await request.json();
        const enabled = body.buzzer === true;

        await this.ctx.storage.put("buzzerEnabled", enabled);

        return jsonResponse({
          success: true,
          buzzer: enabled
        });
      } catch (error) {
        return jsonResponse(
          {
            success: false,
            error: "Data buzzer tidak valid"
          },
          400
        );
      }
    }

    // =========================================================
    // POST DATA SENSOR DARI ESP32
    // =========================================================
    if (
      request.method === "POST" &&
      url.pathname === "/api/sensor"
    ) {
      // CEK API KEY
      const apiKey = request.headers.get("X-API-Key");

      if (
        !apiKey ||
        !this.env.DEVICE_API_KEY ||
        apiKey !== this.env.DEVICE_API_KEY
      ) {
        return jsonResponse(
          {
            success: false,
            error: "Unauthorized"
          },
          401
        );
      }

      try {
        const body = await request.json();

        // VALIDASI DATA
        if (
          !body.device ||
          !Array.isArray(body.readings)
        ) {
          return jsonResponse(
            {
              success: false,
              error: "Format data tidak valid"
            },
            400
          );
        }

        if (body.readings.length === 0) {
          return jsonResponse(
            {
              success: false,
              error: "Readings kosong"
            },
            400
          );
        }

        // AMBIL DATA TERBARU
        const reading = body.readings[body.readings.length - 1];

        // AMBIL STATUS BUZZER DARI STORAGE
        const storedBuzzer = await this.ctx.storage.get("buzzerEnabled");

        // SIMPAN DATA SENSOR (TERMASUK AKTIVITAS PIR)
        const sensorData = {
          db: Number(reading.db) || 0,
          warning: reading.warning === true,
          aktivitas: reading.aktivitas ?? reading.activity ?? body.aktivitas ?? body.activity ?? "-",
          buzzer:
            storedBuzzer !== undefined
              ? storedBuzzer
              : reading.buzzer !== false,
          device: body.device,
          timestamp: reading.t || new Date().toISOString(),
          lastSeen: Date.now()
        };

        await this.ctx.storage.put("sensorData", sensorData);

        // BALAS KE ESP32
        return jsonResponse({
          success: true,
          message: "Data sensor diterima",
          buzzer: sensorData.buzzer
        });
      } catch (error) {
        return jsonResponse(
          {
            success: false,
            error: "JSON tidak valid"
          },
          400
        );
      }
    }

    // =========================================================
    // ENDPOINT TIDAK DITEMUKAN
    // =========================================================
    return jsonResponse(
      {
        error: "Endpoint tidak ditemukan"
      },
      404
    );
  }
}

// =============================================================
// WORKER UTAMA
// =============================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =======================================================
    // API SENSOR
    // =======================================================
    if (url.pathname === "/api/sensor") {
      const id = env.SENSOR_STATE.idFromName("esp-sound-01");
      const stub = env.SENSOR_STATE.get(id);
      return stub.fetch(request);
    }

    // =======================================================
    // TES MANUAL PENCATATAN KE GOOGLE SHEETS
    // =======================================================
    if (url.pathname === "/test-log") {
      const id = env.SENSOR_STATE.idFromName("esp-sound-01");
      const stub = env.SENSOR_STATE.get(id);
      return stub.fetch(
        new Request("https://internal/internal/push-sheets", {
          method: "POST"
        })
      );
    }

    // =======================================================
    // KONTROL BUZZER DARI WEB
    // =======================================================
    if (url.pathname === "/buzzer") {
      if (request.method !== "GET") {
        return jsonResponse(
          {
            success: false,
            error: "Method tidak diizinkan"
          },
          405
        );
      }

      const state = url.searchParams.get("state");

      if (state !== "on" && state !== "off") {
        return jsonResponse(
          {
            success: false,
            error: "state harus on atau off"
          },
          400
        );
      }

      const id = env.SENSOR_STATE.idFromName("esp-sound-01");
      const stub = env.SENSOR_STATE.get(id);

      return stub.fetch(
        new Request("https://internal/set-buzzer", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            buzzer: state === "on"
          })
        })
      );
    }

    // =======================================================
    // FILE WEBSITE
    // =======================================================
    return env.ASSETS.fetch(request);
  },

  // =========================================================
  // CRON TRIGGER OTOMATIS TIAP 30 MENIT
  // =========================================================
  async scheduled(event, env, ctx) {
    const id = env.SENSOR_STATE.idFromName("esp-sound-01");
    const stub = env.SENSOR_STATE.get(id);

    ctx.waitUntil(
      stub.fetch(
        new Request("https://internal/internal/push-sheets", {
          method: "POST"
        })
      )
    );
  }
};

// =============================================================
// JSON RESPONSE
// =============================================================
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
