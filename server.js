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
    // 1. Basic Stats
    const totalEvents = await prisma.rawEvent.count();
    const uniqueSessions = await prisma.rawEvent.groupBy({
      by: ["sessionId"],
    });
    const uniqueVisitors = await prisma.rawEvent.groupBy({
      by: ["visitorId"],
      _count: { visitorId: true },
      where: { visitorId: { not: null } }
    });

    // 2. Event Type Breakdown
    const eventCounts = await prisma.rawEvent.groupBy({
      by: ["eventType"],
      _count: { eventType: true },
    });

    const counts = {};
    eventCounts.forEach(c => counts[c.eventType] = c._count.eventType);

    // 3. Most Visited Pages (Only counting actual views)
    const pageVisits = await prisma.rawEvent.groupBy({
      by: ["page"],
      _count: { page: true },
      where: { eventType: "page_view" },
      orderBy: { _count: { page: "desc" } },
      take: 10,
    });

    // 4. Time Data (Duration)
    const sessionDurations = await prisma.sessionData.aggregate({
      _avg: { duration: true },
      _sum: { duration: true },
    });

    const pageDurations = await prisma.sessionData.groupBy({
      by: ["page"],
      _avg: { duration: true },
      orderBy: { _avg: { duration: "desc" } },
      take: 10,
    });

    // 5. Recent Events for the table
    const recentEvents = await prisma.rawEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    // 6. Visits by Period (Daily)
    const dailyVisits = await prisma.$queryRaw`
      SELECT 
        DATE_TRUNC('day', "createdAt") as day,
        COUNT(*) as count
      FROM "RawEvent"
      WHERE "eventType" = 'page_view'
      GROUP BY day
      ORDER BY day DESC
      LIMIT 7
    `;

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Advanced Analytics Dashboard</title>
          <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
          <style>
              :root {
                  --primary: #2563eb;
                  --secondary: #64748b;
                  --success: #22c55e;
                  --bg: #f8fafc;
                  --card: #ffffff;
                  --text: #1e293b;
              }
              body { 
                  font-family: 'Inter', system-ui, -apple-system, sans-serif; 
                  background: var(--bg); 
                  color: var(--text); 
                  margin: 0; 
                  padding: 20px; 
              }
              .container { max-width: 1200px; margin: 0 auto; }
              header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; }
              h1 { margin: 0; font-size: 1.5rem; color: var(--primary); }
              
              .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 20px; margin-bottom: 30px; }
              .stat-card { 
                  background: var(--card); 
                  padding: 20px; 
                  border-radius: 12px; 
                  box-shadow: 0 1px 3px rgba(0,0,0,0.1); 
                  display: flex;
                  flex-direction: column;
              }
              .stat-card .label { font-size: 0.875rem; color: var(--secondary); margin-bottom: 8px; font-weight: 500; }
              .stat-card .value { font-size: 1.5rem; font-weight: 700; color: var(--text); }
              
              .charts-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; margin-bottom: 30px; }
              @media (max-width: 768px) { .charts-grid { grid-template-columns: 1fr; } }
              
              .card { 
                  background: var(--card); 
                  padding: 24px; 
                  border-radius: 12px; 
                  box-shadow: 0 1px 3px rgba(0,0,0,0.1); 
                  margin-bottom: 20px;
              }
              .card h2 { margin-top: 0; font-size: 1.125rem; margin-bottom: 20px; color: var(--secondary); }
              
              table { width: 100%; border-collapse: collapse; }
              th, td { text-align: left; padding: 12px; border-bottom: 1px solid #f1f5f9; }
              th { font-size: 0.75rem; text-transform: uppercase; color: var(--secondary); font-weight: 600; }
              tr:hover { background: #f8fafc; }
              
              .tag { padding: 4px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: 600; }
              .tag-page_view { background: #dbeafe; color: #1e40af; }
              .tag-button_click { background: #fef3c7; color: #92400e; }
              .tag-page_time { background: #dcfce7; color: #166534; }
              .tag-form_submit { background: #f3e8ff; color: #6b21a8; }
          </style>
      </head>
      <body>
          <div class="container">
              <header>
                  <h1>Analytics Pro</h1>
                  <div style="font-size: 0.875rem; color: var(--secondary);">Auto-refreshing...</div>
              </header>

              <div class="grid">
                  <div class="stat-card">
                      <div class="label">Total Page Views</div>
                      <div class="value">${counts.page_view || 0}</div>
                  </div>
                  <div class="stat-card">
                      <div class="label">Unique Sessions</div>
                      <div class="value">${uniqueSessions.length}</div>
                  </div>
                  <div class="stat-card">
                      <div class="label">Avg. Session Duration</div>
                      <div class="value">${Math.round(sessionDurations._avg.duration || 0)}s</div>
                  </div>
                  <div class="stat-card">
                      <div class="label">Total Button Clicks</div>
                      <div class="value">${counts.button_click || 0}</div>
                  </div>
              </div>

              <div class="charts-grid">
                  <div class="card">
                      <h2>Most Visited Pages</h2>
                      <table>
                          <thead>
                              <tr>
                                  <th>Page Path</th>
                                  <th>Visits</th>
                                  <th>Avg. Time</th>
                              </tr>
                          </thead>
                          <tbody>
                              ${pageVisits.map(p => {
                                const avgTime = pageDurations.find(d => d.page === p.page)?._avg.duration || 0;
                                return `
                                  <tr>
                                      <td><code>${p.page}</code></td>
                                      <td>${p._count.page}</td>
                                      <td>${Math.round(avgTime)}s</td>
                                  </tr>
                                `;
                              }).join('')}
                          </tbody>
                      </table>
                  </div>
                  <div class="card">
                      <h2>Event Distribution</h2>
                      <canvas id="eventChart"></canvas>
                  </div>
              </div>

              <div class="card">
                  <h2>Recent Activity</h2>
                  <table>
                      <thead>
                          <tr>
                              <th>Time</th>
                              <th>Event</th>
                              <th>Page</th>
                              <th>Session ID</th>
                          </tr>
                      </thead>
                      <tbody>
                          ${recentEvents.map(e => `
                              <tr>
                                  <td>${new Date(e.createdAt).toLocaleTimeString()}</td>
                                  <td><span class="tag tag-${e.eventType}">${e.eventType}</span></td>
                                  <td>${e.page}</td>
                                  <td><code>${e.sessionId.substring(0, 8)}</code></td>
                              </tr>
                          `).join('')}
                      </tbody>
                  </table>
              </div>
          </div>

          <script>
              const ctx = document.getElementById('eventChart').getContext('2d');
              new Chart(ctx, {
                  type: 'doughnut',
                  data: {
                      labels: ${JSON.stringify(Object.keys(counts))},
                      datasets: [{
                          data: ${JSON.stringify(Object.values(counts))},
                          backgroundColor: ['#2563eb', '#22c55e', '#f59e0b', '#8b5cf6', '#ef4444']
                      }]
                  },
                  options: {
                      responsive: true,
                      plugins: { legend: { position: 'bottom' } }
                  }
              });
              
              setTimeout(() => location.reload(), 30000);
          </script>
      </body>
      </html>
    `;
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading dashboard: " + err.message);
  }
});

app.listen(process.env.PORT, () => {
  console.log(
    `Server running on http://localhost:${process.env.PORT}`
  );
});