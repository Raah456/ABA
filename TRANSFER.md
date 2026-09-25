# Moving this project to its own GitHub repository

You have three files:

- `aba-practice-platform.zip`: all the code (no history)
- `aba-practice-platform.bundle`: the same code **with its full git history**
- `aba-practice-demo.html`: the clickable demo. Open it in any browser; it needs no server.

## Option A: GitHub website only (no command line)

1. On github.com, click **+** → **New repository**. Name it `aba-practice-platform`, choose **Private**,
   and leave "Add a README" **unchecked**. Click **Create repository**.
2. On the new repo page, click **uploading an existing file**.
3. Unzip `aba-practice-platform.zip` on your computer. Open the `aba-practice-platform` folder, select
   **everything inside it** (including the `src`, `public`, `test` and `tools` folders), and drag it onto the
   upload page.
4. Click **Commit changes**.

Hidden files such as `.gitignore` may not upload by drag and drop. That's fine; you can add it later.
This option does not keep the commit history.

## Option B: command line (keeps history)

1. Create the empty private repository as in step 1 above.
2. Run:

```bash
git clone aba-practice-platform.bundle aba-practice-platform
cd aba-practice-platform
git remote set-url origin https://github.com/YOUR-USERNAME/aba-practice-platform.git
git push -u origin main
```

## Option C: let Claude do it

Create the empty repository (step 1), make sure the Claude GitHub app can access it
(https://claude.ai/connect-github), then ask Claude to push the project there.

## After it's on GitHub

```bash
npm install
npm run seed
DEMO_MODE=1 npm start     # http://localhost:3000
npm test
```

Needs Node.js 22.5 or newer. See README.md for everything else.
