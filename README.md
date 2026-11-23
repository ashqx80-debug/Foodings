# FairCart: free, non-profit grocery deal finder

Users share their location (or type a ZIP code), see nearby grocery stores on a map,
type a shopping list, and get the best deals ranked by **unit price**.

- **Store map:** OpenStreetMap (free, no key needed)
- **Real prices:** Kroger's official API (covers Kroger, Ralphs, Fred Meyer, King Soopers, Harris Teeter, Smith's, Fry's, QFC and more)
- **AI list reading (optional):** Claude reads messy lists like "cheap 2% milk and some eggs"

---

## 1. Run it on your computer (5 minutes)

1. Install **Node.js** (the "LTS" version) from https://nodejs.org
2. Unzip this folder somewhere easy, like your Desktop.
3. Open a terminal in the folder:
   - **Windows:** open the folder, click the address bar, type `cmd`, press Enter
   - **Mac:** right-click the folder → *New Terminal at Folder*
4. Type this and press Enter:
   ```
   node server.js
   ```
5. Open **http://localhost:3000** in your browser.

It starts in **demo mode** with made-up prices (a yellow banner says so), so you can
try the whole site before getting any keys. Press `Ctrl + C` in the terminal to stop it.

## 2. Turn on real prices (free)

Kroger's developer terms are a legal agreement. If you're under 18, have a parent or
guardian create the account.

1. Go to https://developer.kroger.com and create an account.
2. Register a new application. Choose the **Production** environment and
   the **Products** API. (Locations is included.)
3. Copy the **Client ID** and **Client Secret**.
4. In this folder, copy `.env.example` and rename the copy to `.env`
5. Paste your keys in:
   ```
   KROGER_CLIENT_ID=your-id-here
   KROGER_CLIENT_SECRET=your-secret-here
   ```
6. Stop the server (`Ctrl + C`) and start it again with `node server.js`.
   The terminal should say **Mode: LIVE**.

If there's no Kroger-family store within 15 miles of you, try a ZIP code
in a city that has one (like 45202, Cincinnati) to test.

## 3. Turn on AI list reading (optional)

Without this, the site still works. Users just separate items with commas.
To let AI understand any kind of list, add an Anthropic API key to `.env`:
```
ANTHROPIC_API_KEY=your-key-here
```
It uses a small, cheap model. Each search costs a fraction of a cent.

## ⚠️ Keep your keys secret

- **Never** share your `.env` file or put your keys in `public/` files.
- The `.gitignore` file already stops `.env` from being uploaded to GitHub.
- The keys stay on the server. The browser only talks to `/api/search`.

---

## How the files fit together

```
server.js          ← the backend: talks to Kroger + AI, ranks deals
public/
  index.html       ← the page layout
  style.css        ← the look
  app.js           ← location, map, sending the list, showing results
.env               ← your secret keys (you create this)
```

**What happens when someone searches:**
1. `app.js` sends the list + location to `server.js`.
2. The server (optionally) asks AI to turn the list into clean search words.
3. It finds up to 5 Kroger-family stores nearby and searches every item at every store at once.
4. It works out unit prices ("1/2 gal" → 64 fl oz) so big and small sizes compare fairly,
   and uses sale prices when there's a sale.
5. The page shows the best deal per item, the total if you shop smart,
   and the best single store if you only want one trip.

## Putting it online

When you're ready for other people to use it, host it on a free tier at
**Render** (render.com) or **Railway** (railway.app). Connect your GitHub repo, set the start
command to `node server.js`, and add your keys as **environment variables** in
their dashboard. (Don't upload the `.env` file.) A parent may need to create the hosting
account depending on the service's age rules.

## Ideas for next steps

- Add more data sources (Instacart Developer Platform, local store partnerships)
- Let users save lists and favorite stores
- Show distance to each store in the results
- Make it a "progressive web app" so people can add it to their phone's home screen
- Spanish language option
