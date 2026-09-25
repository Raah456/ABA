# Putting ABA Practice Platform online

This guide gets the app running on a server covered by a HIPAA Business Associate Agreement (BAA),
over HTTPS, with two-factor sign-in required and encrypted backups copied off the server.
Plan on about an hour the first time.

## 1. Choose a host that will sign a BAA

Client records are protected health information (PHI). The company that runs the server must sign a BAA
with your practice **before** any real client data goes in. The setup below works on any Linux server,
so pick the provider first:

| Provider | How the BAA is signed | Server | Off-site backup storage |
|---|---|---|---|
| **Amazon Web Services** | Accept the AWS BAA in the console under **AWS Artifact → Agreements** | EC2 instance (Ubuntu) | S3 bucket |
| **Microsoft Azure** | Included in Microsoft's Product Terms / Data Protection Addendum | Azure Virtual Machine | Blob Storage |
| **Google Cloud** | Accept the BAA in the Cloud console (Privacy & Security) | Compute Engine VM | Cloud Storage bucket |

Only use services the provider lists as HIPAA-eligible under its BAA, and check the provider's current terms:
they change. Many low-cost hosting companies do **not** sign BAAs; don't use them for real records.

A small server is enough to start: 2 GB memory, 2 CPUs, 20 GB disk. **Turn on disk encryption**
(on AWS: "Encrypt this volume" / EBS encryption by default).

## 2. Prepare the server

1. Create the server with Ubuntu 24.04 LTS. Allow inbound ports **22** (SSH, only from your office IP if you can),
   **80** and **443**. Nothing else.
2. In your domain's DNS, add an **A record** such as `aba.yourpractice.com` pointing to the server's public IP.
3. Sign in over SSH and install Docker and security updates:

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install docker.io docker-compose-v2 git unattended-upgrades
sudo systemctl enable --now docker
sudo dpkg-reconfigure -plow unattended-upgrades   # automatic security updates
```

## 3. Install the app

```bash
git clone https://github.com/Raah456/aba.git
cd aba
cp .env.example .env
openssl rand -base64 32      # prints a new encryption key
nano .env
```

In `.env`, fill in:

- `DOMAIN`: the address from step 2.
- `APP_ENCRYPTION_KEY`: the key you just printed. **Save it in your practice's password manager now**, and make sure a
  second trusted person can reach it. Without it, backups can't be restored.
- `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD`: the owner's account (password at least 12 characters).

Start it:

```bash
sudo docker compose up -d --build
sudo docker compose logs -f app      # Ctrl+C to stop watching
```

Caddy gets an HTTPS certificate automatically within a minute. Open `https://aba.yourpractice.com`.

## 4. First sign-in

1. Sign in as the owner. You'll be asked to set up **two-factor sign-in** straight away (it's required by default).
   Save the recovery codes in the password manager.
2. Remove `ADMIN_PASSWORD` from `.env`, then run `sudo docker compose up -d`.
3. **Staff accounts**: add everyone with a temporary password. Each person sets up two-factor at their first sign-in.
4. **Security & backups**: press **Back up now** and check it says OK.

## 5. Turn on off-site backups

Backups are written to the server every 24 hours, encrypted. A copy must also live somewhere else, or losing the
server loses everything.

1. Create a private bucket with your BAA provider (e.g. an S3 bucket with "Block all public access" on and default
   encryption on). Add a lifecycle rule to delete objects older than 400 days.
2. Create an access key that can only write to that bucket.
3. Fill in the `OFFSITE_REMOTE` and `RCLONE_CONFIG_OFFSITE_*` lines in `.env`, then:

```bash
sudo docker compose --profile offsite up -d
sudo docker compose logs offsite-backup     # should say "off-site copy OK"
```

The files are encrypted before they leave the server, so the storage provider only ever holds ciphertext.

## 6. Restoring a backup

Practice this once now and then every few months, so you know it works.

```bash
sudo docker compose stop app
sudo docker compose run --rm --no-deps app node src/cli/restore.js            # lists backups
sudo docker compose run --rm --no-deps app node src/cli/restore.js /data/backups/aba-YYYYMMDD-HHMMSS.db.enc --force
sudo docker compose start app
```

To restore from the off-site copy onto a brand-new server, install the app as in step 3 with the **same**
`APP_ENCRYPTION_KEY`, copy the backup file into the `app-data` volume's `backups` folder, and run the restore command.

## 7. Updating the app

```bash
cd aba
git pull
sudo docker compose up -d --build
```

The database upgrades itself on start. A backup before updating is a good habit:
`sudo docker compose exec app node src/cli/backup.js`.

## What this setup does, and what's still yours

Built in:

- HTTPS everywhere (certificates renew automatically; plain HTTP is redirected; HSTS).
- Two-factor sign-in, required by default, with recovery codes and resets for lost phones.
- Sign-out after 30 minutes idle; role-based access; an audit log of every record view and change.
- Encrypted daily backups with 30-day + 12-month retention, an off-site copy, and a tested restore command.

Still the practice's responsibility under HIPAA:

- Signing the BAA with the host (step 1), and a BAA with any other vendor that touches PHI.
- A written risk assessment, security policies, and staff training.
- Keeping the encryption key and recovery codes safe, and removing accounts the day someone leaves.
- Reviewing the audit log (Settings → Audit log) regularly.
