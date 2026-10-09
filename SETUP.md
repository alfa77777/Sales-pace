# Sales Pace — Google Sheets setup

This folder has two parts:

- `site/` — the website. Upload it to Netlify.
- `Code.gs` — the backend. Paste it into Apps Script.

Your existing logins, sales, standards and audit log keep working. The update adds new columns and two new tabs by itself:

- **Sellers → Category** (column F) and **StartDate** (column G)
- **Entries → Class** (column E)
- **CallTime** tab: call time per seller per day, in minutes
- **PlanConfig** tab: pay rules per month. Don't edit it by hand.

---

## 1. Back up the sheet

A copy lets you undo everything.

1. Open your Google Sheet.
2. Click **File → Make a copy**.

## 2. Set the time zone to Tashkent

Sales dates and "this month" come from these settings.

1. In the sheet, open **File → Settings → Time zone**.
2. Choose **(GMT+05:00) Tashkent**. Click **Save settings**.
3. Open **Extensions → Apps Script → Project Settings** (gear icon).
4. Set **Time zone** to **(GMT+05:00) Tashkent**.

## 3. Update the backend

1. In Apps Script, open **Code.gs**.
2. Select all. Paste the new `Code.gs` over it.
3. Press **Ctrl + S** to save.

## 4. Redeploy (this is the step people miss)

Saving alone does not change the live site.

1. Click **Deploy → Manage deployments**.
2. Click the **✏️ pencil** on your current deployment.
3. Set **Version** to **New version**.
4. Click **Deploy**.

The `/exec` URL stays the same, so step 5 is only needed the first time.

**If you have never deployed:** choose **Deploy → New deployment → Web app**. Set **Execute as: Me** and **Who has access: Anyone**. Copy the URL that ends in `/exec`.

## 5. Put the URL in the site (first time only)

1. Open `site/index.html` in a text editor.
2. Find `PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE`.
3. Replace it with your `/exec` URL. Keep the quotes. Save.

## 6. Upload the site

1. Open your site on **Netlify → Deploys**.
2. Drag the **`site`** folder onto the upload area. (Do not upload `Code.gs`.)
3. Wait for **Published**.

## 7. Set up pay (once)

Old personal targets are **not** used anymore. Plans now come from each seller's category.

1. Log in as admin (same username and password as before).
2. Open **Settings → Plans & pay**.
3. Check the team plan, the C and Other tables, and the leader table.
4. Click **Save rules for [this month]**.
5. Click each seller in the sidebar. Choose **C** or **Other** under **Set category**.
6. For a seller with a different plan, open **Account** and type an **Own plan**.
7. For a seller who started this month, set their **Start date** in **Account**. Their plan for that month is prorated by days; their fixed pay is not.

## 8. Check it works

1. Click **+ Add sale**. Save a small test sale with a class.
2. Open the sheet's **Entries** tab. Confirm the row has the class in column E.
3. Delete the test sale in the app.

---

## If something is wrong

- **"Unknown action" or "Nothing to change" on save** → the old backend is still live. Repeat step 4 and pick **New version**.
- **The page still looks old** → press **Ctrl + Shift + R** (phone: close the tab and reopen).
- **"Could not reach Google Sheets"** → check that the URL in `index.html` ends in `/exec` and the deployment is **Anyone**.
- **Sales show on the wrong day** → recheck both time zones in step 2.
- **To log everyone out at once** → Apps Script → **Project Settings → Script Properties** → delete `SESSION_SECRET`.
