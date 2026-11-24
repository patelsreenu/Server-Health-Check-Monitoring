# Health Monitor

One dashboard for the health of a mixed estate: Windows and Linux servers, AWS, Azure, OCI and VMware (vCenter / VMC), with optional tabs for network devices and Palo Alto firewalls. It collects CPU, memory, disk, services and event logs, keeps a history, forecasts trouble before it happens, emails alerts, and lets admins take a few controlled actions. An AI model is optional.

It runs on a single jump box inside your network and installs nothing on the servers it monitors.

## What it does

| Area | Features |
| --- | --- |
| **Three tabs** | **Servers Monitoring** (always on), **Network Monitoring** and **Firewall Monitoring** (each shown only when configured) |
| **Fleet view** | Every server by platform and environment, with status, CPU, memory and disk at a glance |
| **Server detail** | Disks, services, event-log errors, uptime and history charts |
| **Nudges** | Trend forecasts (for example "disk C: full in 9 days") and plain-English grouping of event-log noise. No AI needed |
| **Insights** | Correlates failures across servers. With an AI key, it also explains the probable cause and next steps |
| **Alerts** | Email digest for sustained CPU or memory breaches and low disk, with reminders and optional "resolved" mails |
| **Endpoint checks** | HTTP(S) URLs checked on a schedule, with an email when one goes down or comes back |
| **Actions** | Start, stop or restart a server, run a script, restart a Windows service. Each asks for the person's admin credentials and a confirmation (see the security notes) |
| **Incidents** | A **Raise incident** button drafts a ServiceNow ticket. Nothing is raised automatically |
| **Network Monitoring** | Your network poller's own pages (the NetOps NOC platform: overview, devices, alerts, SD-WAN, interfaces, reports, admin), shown unchanged inside the tab |
| **Firewall Monitoring** | The PAN-OS Traffic Portal's own pages, shown unchanged inside the tab: firewall status, traffic log search by source, destination, port, application, action and protocol, CSV export, and the server and application directory |

## Architecture

```
 Browser ──HTTPS 3001──►  Jump box (Node.js)  ──WinRM 5985──► Windows servers
 AWS SSO sign-in          • web dashboard      ──SSH 22─────► Linux servers
 AD (LDAP) admin checks   • collectors         ──APIs───────► AWS / Azure / OCI / vCenter
 SMTP relay ◄──────────── • history (SQLite)
 AI API (optional) ◄───── • alerts and nudges
```

## Requirements

- **Node.js 22.5 or later.** History uses the built-in `node:sqlite` module.
- **A Windows or Linux host** that can reach the servers. Windows is needed to run PowerShell remoting to Windows targets.
- **Accounts:**
  - a read-only WinRM account on Windows targets;
  - an SSH account on Linux targets;
  - an AWS IAM Identity Center (SSO) start URL for sign-in;
  - optionally, an AD service account for the admin checks.

## Quick start

```bash
git clone <this repo> health-monitor
cd health-monitor
npm install
cp .env.example .env          # then fill it in
npm start                     # https://localhost:3001
```

Set up these files in `server/config/` (the repository ships examples):

| File | Purpose |
| --- | --- |
| `servers.json` | The servers to monitor. Alternatively use `servers.xlsx` with sheets **Servers**, **POS** and **Databases**; the columns are documented in `server/services/excelConfig.js`. Passwords can be `${ENV_VAR}` references |
| `clouds.json` | The AWS SSO start URL, account and role. Azure and OCI are optional |
| `ldap.json` | The domain controllers and service account for admin checks |
| `endpoints.json` | The URLs to check |
| `exclusions.json` | Servers to leave out, such as powered-off VMs |
| `hostGroups.json` | Host-name prefix to environment mapping, used when a server has no `group` |
| `scripts.json` | The approved scripts offered under **Run Script** |
| `serviceControl.json` | Who may restart services, and the services that are never restarted |
| `servicenow.json` | Optional. Leave `instanceUrl` blank to turn incidents off |

> **Keep your real inventory private.** If you fork this publicly, do not commit your own `servers.json`, `ldap.json` or `clouds.json`. Put them in a private fork or deployment repo.

## Running as a service (Windows)

Create a scheduled task that runs at start-up with the highest privileges:

```powershell
$a = New-ScheduledTaskAction -Execute "node.exe" -Argument "server\index.js" -WorkingDirectory "C:\HealthMonitor"
$t = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName "HealthMonitor" -Action $a -Trigger $t -RunLevel Highest -User "CORP\svc-healthmonitor" -Password "<password>"
```

To restart it after a change:

```powershell
Stop-ScheduledTask -TaskName "HealthMonitor"; Start-ScheduledTask -TaskName "HealthMonitor"
```

## Network and firewall tabs (optional)

These two tabs show tools that run alongside the Health Monitor, with all their own features. The Health Monitor serves their pages through itself at `/tools/network/` and `/tools/firewall/` (see `server/routes/toolsProxy.js`). That way they load from the dashboard's own address and certificate and sit behind its sign-in. The only change on the way through is pointing their `/api/...` calls at `/tools/<tool>/api/...`. Each tab stays hidden until its address is set in `.env`.

The summary strip on the Servers tab reads a few figures from the same tools through `server/routes/network.js`, which keeps only the fields it shows and never passes on SNMP credentials.

| Setting | Points to |
| --- | --- |
| `NETOPS_URL` | The NetOps NOC platform (SNMP/ICMP polling of switches, routers, APs and SD-WAN) |
| `PANOS_PORTAL_URL` | The PAN-OS Traffic Portal (Palo Alto XML API) |
| `NETWORK_INSECURE_TLS` | Accept self-signed certificates from those tools | Default: only for `localhost` |

To show a different web tool in a tab, add it to `TOOLS` in `server/routes/toolsProxy.js`, with any path rewrites its pages need.

## AI (optional)

Point it at any provider with an HTTPS API by setting `AI_API_URL`, `AI_API_KEY` and `AI_MODEL`.

- `AI_API_FORMAT=chat` (the default) uses the OpenAI-style `/chat/completions` format.
- `AI_API_FORMAT=messages` uses the `/messages` format.
- `AI_REDACT_HOSTNAMES=true` keeps host names from being sent to the provider.
- `AI_HOURLY_BUDGET` caps the number of calls.

Without a key, forecasts, log grouping, correlation and alerts all still work.

## Security notes

- **Collection is read-only.** Changes happen only when a person clicks an action and confirms it.
- **Service restarts** are checked on the server:
  - they run with the person's own credentials;
  - protected services are refused;
  - every attempt is logged to `server/data/service-actions.log` and emailed.
- **Known gap:** server start, stop and restart, and **Run Script**, check admin rights in the browser only. The server then runs them with the collection account, and Run Script accepts any script text. Anyone signed in could call these API routes directly. Until this is fixed, give the collection account no more rights than you are happy for every signed-in user to have, or remove those routes from `server/routes/actions.js`.
- **Use a proper certificate** in production. Set `TLS_PFX_PATH` or `TLS_CERT_PATH`/`TLS_KEY_PATH`; otherwise a self-signed certificate is generated.
- **Never commit `.env`.** It is already in `.gitignore`.

## Project layout

```
server/
  index.js            HTTPS server and routes
  routes/             auth, fleet, subnet, server detail, actions, tickets, ai, network + firewall
  services/           collectors (WinRM, SSH, AWS, Azure, OCI), history, forecast, alerts, AI
  config/             your configuration (examples included)
src/                  single-page web app (plain JS, no build step)
scripts/              helpers (send a test alert, export the inventory to Excel)
```
