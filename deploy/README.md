# Deploying GammaTerminal to an Oracle Cloud (OCI) instance

Goal: the terminal runs 24/7 on your OCI VM, reachable from any browser at
`http://<public-ip>/`, with one static IP you whitelist in Flattrade.

---

## 0. Prerequisites on the OCI side (console: cloud.oracle.com)

1. **Instance**: Ubuntu 22.04 or 24.04, any shape (the free `VM.Standard.A1.Flex`
   1 OCPU / 6 GB is plenty). Note the **public IP** and download the SSH key.
2. **Reserve the public IP** so it survives stop/start:
   Instance → *Attached VNICs* → the VNIC → *IPv4 Addresses* → Edit the primary
   IP → change **Ephemeral → Reserved**. (Do this before whitelisting in Flattrade.)
3. **Open port 80** at the cloud firewall:
   Networking → *Virtual Cloud Networks* → your VCN → *Security Lists* → default →
   *Add Ingress Rule*: Source `0.0.0.0/0`, IP Protocol `TCP`, Destination port `80`
   (add `443` too if you'll add HTTPS later).

---

## 1. Get the code onto the VM

**Option A — GitHub (recommended, makes updates one command):**

On your laptop, in `E:\TERMINAL NEW`:

```bash
git init
git add -A
git commit -m "GammaTerminal"
# create a PRIVATE repo on github.com, then:
git remote add origin git@github.com:<you>/gammaterminal.git
git push -u origin main
```

On the VM:

```bash
sudo mkdir -p /opt/gammaterminal && sudo chown $USER /opt/gammaterminal
git clone https://github.com/<you>/gammaterminal.git /opt/gammaterminal
```

**Option B — copy directly (no GitHub):** from your laptop
`scp -i <key> -r "E:\TERMINAL NEW" ubuntu@<public-ip>:/opt/gammaterminal`

---

## 2. One-shot setup

```bash
cd /opt/gammaterminal
bash deploy/setup.sh
```

This installs Python/Node/nginx, builds the frontend, installs a **systemd**
service for the backend, wires **nginx** (static app + `/api` + `/ws` proxy),
opens the instance firewall for port 80, and writes a starter `backend/.env`.

When it finishes it prints the remaining manual steps.

---

## 3. Connect Flattrade

1. In the Flattrade API portal, set your app's **Redirect URL** to **exactly**:
   `http://<public-ip>/api/broker/callback`
2. Whitelist `<public-ip>` there too (or ask support to disable IP whitelisting).
3. Edit `/opt/gammaterminal/backend/.env`:

   ```
   FLATTRADE_API_KEY=...
   FLATTRADE_API_SECRET=...
   FLATTRADE_CLIENT_ID=...
   FLATTRADE_REDIRECT_URL=http://<public-ip>/api/broker/callback
   POLL_INTERVAL=3
   ```

4. `sudo systemctl restart gammaterminal-backend`
5. Open `http://<public-ip>/` in your browser → click **Connect Flattrade** in the
   header → finish the Flattrade login → the redirect lands back on the VM and the
   day token is saved to `data/broker_session.json`. Re-auth once each trading day.

---

## 4. Lock it down (do this before sharing the URL)

The app has **no login** and in LIVE mode can place **real orders**. At minimum add
HTTP basic auth:

```bash
sudo htpasswd -c /etc/nginx/.htpasswd youruser
sudo nano /etc/nginx/sites-available/gammaterminal   # uncomment the two auth_basic lines
sudo systemctl reload nginx
```

### HTTPS (optional, needs a domain)

Point a domain's A-record at the public IP, set `server_name` in the nginx conf,
open port 443 in the OCI Security List, then:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d terminal.yourdomain.com
```

Then change `FLATTRADE_REDIRECT_URL` (and the Flattrade app) to the `https://…` URL.

---

## Day-to-day

| Task | Command |
|---|---|
| Backend logs | `journalctl -u gammaterminal-backend -f` |
| Restart backend | `sudo systemctl restart gammaterminal-backend` |
| Deploy an update | `cd /opt/gammaterminal && git pull && bash deploy/setup.sh` |
| Free-tier keep-alive | OCI reclaims *idle* Always-Free VMs — this app's poller keeps CPU non-idle during market hours; fine. |
