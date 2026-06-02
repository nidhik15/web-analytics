require("dotenv").config({ override: true });

const express = require("express");
const cors = require("cors");
const prisma = require("./src/prisma");

const app = express();

// Prisma connection test
(async () => {
  try {
    await prisma.$connect();
    console.log("Prisma connected to Supabase");
  } catch (err) {
    console.error("Prisma connection failed:", err);
    process.exit(1);
  }
})();

// CORS
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN,
    methods: ["GET", "POST"],
    credentials: true,
  })
);

app.use(express.json({ limit: "10kb" }));

// VALIDATION
const VALID_EVENTS = [
  "page_view",
  "page_time",
  "button_click",
  "form_submit",
];

function validatePayload(body) {
  const { event, page, session_id, duration } = body;

  if (!event || !VALID_EVENTS.includes(event))
    return "Invalid or missing event type";

  if (!page || typeof page !== "string" || page.length > 300)
    return "Invalid or missing page";

  if (
    !session_id ||
    typeof session_id !== "string" ||
    session_id.length > 120
  )
    return "Invalid or missing session_id";

  if (
    event === "page_time" &&
    (typeof duration !== "number" ||
      duration < 0 ||
      duration > 86400)
  ) {
    return "Invalid duration";
  }

  return null;
}

function normalizePayload(body) {
  return {
    event: body.event.trim(),
    page: body.page.trim().slice(0, 300),
    session_id: body.session_id.trim().slice(0, 100),
    visitor_id:
      typeof body.visitor_id === "string"
        ? body.visitor_id.trim().slice(0, 100)
        : null,
    duration:
      typeof body.duration === "number"
        ? Math.abs(Math.round(body.duration))
        : null,
    label:
      typeof body.label === "string"
        ? body.label.trim().slice(0, 200)
        : null,
    href:
      typeof body.href === "string"
        ? body.href.trim().slice(0, 500)
        : null,
  };
}

// local session store
const activeSessions = {};

// TRACK ENDPOINT
app.post("/track", async (req, res) => {
  const error = validatePayload(req.body);

  if (error) {
    return res.status(400).json({ error });
  }

  const data = normalizePayload(req.body);

  try {
    await prisma.rawEvent.create({
      data: {
        eventType: data.event,
        page: data.page,
        sessionId: data.session_id,
        visitorId: data.visitor_id,
        payload: {
          label: data.label,
          href: data.href,
        },
      },
    });

    const key = `${data.session_id}_${data.page}`;

    if (data.event === "page_view") {
      activeSessions[key] = {
        start: new Date(),
      };
    }

    if (data.event === "page_time") {
      await prisma.sessionData.create({
        data: {
          sessionId: data.session_id,
          page: data.page,
          duration: data.duration || 0,
        },
      });

      delete activeSessions[key];
    }

    console.log(
      `[${data.event}] ${data.page} | session=${data.session_id}`
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Internal server error",
    });
  }
});

// TEST EVENTS
app.get("/events", async (req, res) => {
  try {
    const events = await prisma.rawEvent.findMany({
      orderBy: {
        createdAt: "desc",
      },
      take: 20,
    });

    res.json(events);
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});

// HEALTH CHECK
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
  });
});

// DASHBOARD
app.get("/", async (req, res) => {
  try {
    const events = await prisma.rawEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Analytics Dashboard</title>
          <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 1200px; margin: 0 auto; padding: 20px; background: #f4f7f6; }
              h1 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px; }
              .card { background: #fff; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); padding: 20px; margin-bottom: 20px; overflow-x: auto; }
              table { width: 100%; border-collapse: collapse; margin-top: 10px; }
              th, td { text-align: left; padding: 12px; border-bottom: 1px solid #eee; }
              th { background-color: #f8f9fa; color: #7f8c8d; text-transform: uppercase; font-size: 12px; letter-spacing: 1px; }
              tr:hover { background-color: #f9f9f9; }
              .tag { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; text-transform: uppercase; }
              .tag-page_view { background: #d1ecf1; color: #0c5460; }
              .tag-button_click { background: #fff3cd; color: #856404; }
              .tag-page_time { background: #d4edda; color: #155724; }
          </style>
          <script>setTimeout(() => location.reload(), 5000);</script>
      </head>
      <body>
          <h1>Analytics Dashboard</h1>
          <div class="card">
              <h2>Recent Events (Auto-refreshing)</h2>
              <table>
                  <thead>
                      <tr>
                          <th>Time</th>
                          <th>Event</th>
                          <th>Page</th>
                          <th>Session</th>
                          <th>Details</th>
                      </tr>
                  </thead>
                  <tbody>
                      ${events.map(e => `
                          <tr>
                              <td>${new Date(e.createdAt).toLocaleTimeString()}</td>
                              <td><span class="tag tag-${e.eventType}">${e.eventType}</span></td>
                              <td>${e.page}</td>
                              <td><code>${e.sessionId.substring(0, 8)}...</code></td>
                              <td><pre style="margin:0; font-size:10px;">${JSON.stringify(e.payload)}</pre></td>
                          </tr>
                      `).join('')}
                  </tbody>
              </table>
          </div>
      </body>
      </html>
    `;
    res.send(html);
  } catch (err) {
    res.status(500).send("Error loading dashboard: " + err.message);
  }
});

app.listen(process.env.PORT, () => {
  console.log(
    `Server running on http://localhost:${process.env.PORT}`
  );
});