# Set up the Speechify voice (about 20 minutes, one time)

The two apps (I Know and I Know Book) can speak with a Speechify voice. Your Speechify key must **never** go into
the apps. So the key goes into a small free program on the internet: a **Cloudflare Worker**. The apps talk to the
Worker. The Worker talks to Speechify.

You will do 4 things:

1. Make two free accounts (Cloudflare and Speechify).
2. Put the Worker on the internet (a few commands in Terminal).
3. Paste your Speechify key into the Worker. **This is the only place for the key.**
4. Paste the Worker's address and your app code into each app.

You type every key and code yourself. Nobody else sees them.

---

## Step 1. Make a free Cloudflare account

1. Open https://dash.cloudflare.com/sign-up in Safari.
2. Type your email and a password. Click **Sign up**.
3. Open the email from Cloudflare and click the link in it.
4. You do **not** need a website or a credit card. If Cloudflare asks what you want to do, you can skip it.

## Step 2. Make a Speechify API account and copy the key

1. Open https://platform.speechify.ai in Safari.
2. Sign up (email, or "Continue with Google").
3. On the left, click **API Keys** (it can also be under **Settings**).
4. Click **Create key** (or **New API key**). Give it a name, for example `I Know`.
5. Click **Copy**. The key starts with `sk_`.
6. Keep this page open. You will paste the key in Step 6.

The free plan has some free characters each month (see SPEECHIFY-FACTS.md). When they are used up, the apps simply
use the free iPhone voice.

## Step 3. Open Terminal in the speech-proxy folder

1. Open **Terminal** (press Command + Space, type `Terminal`, press Return).
2. Type `cd ` (the letters c, d and one space). Do not press Return yet.
3. In Finder, find the folder **speech-proxy** (it is inside the `meh` folder of the project).
4. Drag the **speech-proxy** folder into the Terminal window. The folder's path appears after `cd `.
5. Press Return.

If Terminal later says `npx: command not found`: install Node.js from https://nodejs.org (the "LTS" button), close
Terminal, open it again, and do Step 3 again.

## Step 4. Get the tools (one time)

Type this and press Return:

```
npm install
```

Wait until it stops (about 1 minute). Some yellow "warn" lines are OK.

## Step 5. Sign in to Cloudflare from Terminal

```
npx wrangler login
```

A browser window opens. Sign in to Cloudflare if it asks. Click **Allow**. Go back to Terminal. It says
"Successfully logged in".

## Step 6. Paste your Speechify key (THE place for the key)

```
npx wrangler secret put SPEECHIFY_API_KEY
```

- If Terminal asks "Do you want to create a new Worker ...?", type `y` and press Return.
- When it says **Enter a secret value**, paste your Speechify key (Command + V) and press Return.
  You will **not** see the key on the screen. That is normal.
- It says "Success! Uploaded secret SPEECHIFY_API_KEY".

The key is now stored safely at Cloudflare. It is not in any file and not in the apps.

## Step 7. Make your app code and save it in the Worker

The app code is a long private password. Only your apps know it. The Worker refuses everybody without it.

1. Make a random code:

   ```
   openssl rand -hex 24
   ```

   Terminal prints a code with 48 letters and numbers. Copy it.
2. **Keep this code**: paste it into the Notes app. You need it again in Step 10.
3. Save it in the Worker:

   ```
   npx wrangler secret put APP_CODE
   ```

   When it says **Enter a secret value**, paste the code and press Return.

## Step 8. Put the Worker on the internet

```
npx wrangler deploy
```

At the end Terminal prints the Worker's address, like:

```
https://iknow-speech.yourname.workers.dev
```

Copy this address. Paste it into Notes too.

This command also makes the character counter (it counts the Speechify characters of each day).
You do not need to do anything for it.

## Step 9. Check that it works

Open the address in Safari. You should see:

```
{"error":"App code missing or wrong","code":"auth"}
```

That is **good**: the Worker is running, and it refuses people without your app code.

(If you see `not-set-up`, Step 6 or Step 7 is missing. Do it again.)

## Step 10. Paste the address and the app code into each app

Do this in **I Know** and in **I Know Book**:

1. Open **Settings**. I Know: the **Settings** tab ▸ **Voice**. I Know Book: the **Settings** tab ▸ **Voice**.
2. Tap **Speechify (natural)** in the voice choice. The Speechify rows appear under it.
3. **Server address**: paste the address from Step 8. Press **Save**.
4. **App code**: paste the code from Step 7. Press **Save**. (It goes into the iPhone's Keychain. The box stays empty
   after that: the code is never shown again.)
5. Press **Test**. It should say "The Speechify Worker works".
6. **Voice**: the British voice marked ★ is the default. You can pick another one.
   (Or choose **Auto** in the voice choice: Auto uses Speechify first when the address and the code are saved.)

The steps of this page are in the apps too: Settings ▸ Voice ▸ **How to set up Speechify**.

In Settings you also see **Speechify today / this month** (characters used) and the **Daily limit**
(20,000 characters at first). When the limit is reached, the app uses the free iPhone voice until tomorrow.

---

## The other way to set a secret: in the Cloudflare website

You can also paste the key in the website instead of Step 6 (for example, to change the key later):

1. Open https://dash.cloudflare.com and sign in.
2. On the left, click **Workers & Pages** (it can be under **Compute**).
3. Click your Worker **iknow-speech**.
4. Click **Settings** (at the top).
5. Find **Variables and Secrets**. Click **Add**.
6. **Type**: choose **Secret**.
7. **Variable name**: type `SPEECHIFY_API_KEY` (exactly like this).
8. **Value**: paste your Speechify key.
9. Click **Deploy** (or **Save**).

The same way works for `APP_CODE`.

## Change the daily limit

1. Open **wrangler.toml** in TextEdit.
2. Change the number in `DAILY_CHAR_LIMIT = "20000"` (for example `"11000"`; on the free Speechify plan with the
   simba-3.5 model, 11,000 a day fits the free amount of the month).
3. Save. In Terminal (in the speech-proxy folder): `npx wrangler deploy`.

The apps also have their own daily limit in Settings. The smaller of the two counts.

## Cheaper voice model

In **wrangler.toml**, `MODEL = "simba-3.5"` is the most natural model. `MODEL = "simba-3.2"` (English only) costs
less and gives more free characters. Change it, save, `npx wrangler deploy`.

## If something goes wrong

| What you see | What to do |
|---|---|
| `npx: command not found` | Install Node.js from https://nodejs.org, then open Terminal again (Step 3). |
| `Not logged in` | `npx wrangler login` again (Step 5). |
| The app says "did not accept the app code" | The app code in the app is not the same as in Step 7. Paste it again. |
| The app says "Speechify did not accept the API key" | Do Step 6 again with a new key from platform.speechify.ai. |
| The app says "no characters left on the Speechify account" | The free amount of this month is used. The iPhone voice reads until next month (or buy a plan). |
| You want to stop Speechify for a moment | In the app, choose another voice. Or in wrangler.toml set `DAILY_CHAR_LIMIT = "0"` and deploy. |
| You think someone else knows your app code | Make a new one (Step 7), and paste the new one into both apps. |
