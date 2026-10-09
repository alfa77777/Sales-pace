# Sales Pace

Sales tracking and payroll dashboard for the Englify sales team. Sellers log daily sales; the app shows the team's pace against the monthly plan, the reward milestones, each seller's forecast, and their pay for the month. English and Uzbek.

## What it does

- **Team dashboard** — plan progress, daily pace needed, leaderboard, latest sales.
- **Team reward milestones** — 25% of plan by day 10, 55% by day 20, 80% by month end.
- **Seller workspaces** — personal pace, forecast, daily target for each commission tier, and pay card.
- **Payroll** — category-based commission tiers (C · Demo class, Other · G/O/A/B), fixed pay, team-leader bonus, mid-month hire proration.
- **Call time & daily standards** — calendar view and compliance tracking.
- **Admin** — manage sellers, plans, bulk sales entry, and open any seller's workspace.
- **Logins** — per-seller accounts with signed 7-day session tokens.

## Structure

| Path | Purpose |
|---|---|
| `site/` | Static website (HTML/CSS/JS, no build step). Host on Netlify or any static host. |
| `site/index.html` | Entry point. Holds the Apps Script `/exec` URL. |
| `site/app.js` | UI and routing |
| `site/pace-lib.js` | Pace, forecast and pay calculations |
| `site/i18n.js` | English / Uzbek strings |
| `site/pace-ui.css` | Styles (dark and light themes) |
| `Code.gs` | Google Apps Script backend. The Google Sheet is the database. |
| `SETUP.md` | Step-by-step setup and troubleshooting |

## Deploy

1. Paste `Code.gs` into the sheet's Apps Script project.
2. Deploy as a Web App (**Execute as: Me**, **Who has access: Anyone**).
3. Put the `/exec` URL in `site/index.html` (`window.SALES_PACE_SCRIPT_URL`).
4. Upload the `site/` folder to Netlify.

After any `Code.gs` edit, redeploy with **Deploy → Manage deployments → ✏️ → New version → Deploy**. Saving alone does not update the live URL.

Full guide: [SETUP.md](SETUP.md).
