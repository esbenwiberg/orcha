# Deploying Orcha on Azure VM

This guide walks you through deploying Orcha on an Azure Linux VM for better performance and to free up your local machine's resources.

## Why Azure VM?

| Local (WSL2) | Azure VM |
|--------------|----------|
| Competes for laptop resources | Dedicated resources |
| Slow filesystem (DrvFS) | Native ext4 (fast) |
| Stops when laptop sleeps | Runs 24/7 if needed |
| Free | ~$30-60/month (or $0 when stopped) |

---

## Prerequisites

**Local machine requirements:**
- [Azure CLI](https://docs.microsoft.com/en-us/cli/azure/install-azure-cli) installed
- `jq` for JSON parsing
- `rsync` for code sync
- Azure subscription (free tier works)

```bash
# Install prerequisites (Ubuntu/Debian/WSL)
sudo apt-get install -y jq rsync

# Verify Azure CLI is installed
az --version

# Login to Azure
az login
```

---

## Quick Start

```bash
# 1. Run the setup script
./scripts/azure-setup.sh

# 2. Sync your local code to the VM
./scripts/azure-manage.sh sync

# 3. SSH in and complete post-setup
./scripts/azure-manage.sh ssh

# On the VM, run these commands:
gh auth login                                    # Authenticate GitHub CLI
echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.bashrc
source ~/.bashrc
cd ~/projects/orcha && npm install && npm run build
~/start-web.sh

# 4. Access via secure tunnel (from your laptop, new terminal)
./scripts/azure-manage.sh tunnel
# Open http://localhost:3000
```

## Post-Setup Checklist

After the VM is created, complete these steps:

- [ ] Sync code: `./scripts/azure-manage.sh sync`
- [ ] SSH into VM: `./scripts/azure-manage.sh ssh`
- [ ] Authenticate GitHub: `gh auth login`
- [ ] Set API key: `echo 'export ANTHROPIC_API_KEY=...' >> ~/.bashrc && source ~/.bashrc`
- [ ] Install dependencies: `cd ~/projects/orcha && npm install`
- [ ] Build: `npm run build`
- [ ] Start dashboard: `~/start-web.sh`
- [ ] Open tunnel (from laptop): `./scripts/azure-manage.sh tunnel`

---

## Setup Options

### Default Configuration

```bash
./scripts/azure-setup.sh
```

Creates:
- Resource group: `orcha-rg`
- VM name: `orcha-dev`
- Size: `Standard_B2ms` (2 vCPU, 8 GB RAM)
- Location: `westeurope`
- Port 3000: **Not exposed** (secure by default)

### Custom Configuration

```bash
# Custom names and location
./scripts/azure-setup.sh my-resource-group my-vm-name westus2

# Specific Azure subscription (by name or ID)
SUBSCRIPTION="My Subscription Name" ./scripts/azure-setup.sh
SUBSCRIPTION="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" ./scripts/azure-setup.sh

# Larger VM for more sessions
VM_SIZE=Standard_B4ms ./scripts/azure-setup.sh

# Expose port publicly (less secure)
EXPOSE_PORT=true ./scripts/azure-setup.sh

# Combine multiple options
SUBSCRIPTION="Dev Subscription" VM_SIZE=Standard_B4ms ./scripts/azure-setup.sh
```

### Subscription Selection

If you have multiple Azure subscriptions, the script will:
1. List all available subscriptions
2. Show which one is currently selected
3. Ask for confirmation before proceeding

```bash
# List your subscriptions
az account list -o table

# Set default subscription (persists)
az account set --subscription "My Subscription Name"

# Or use one-time for this setup
SUBSCRIPTION="My Subscription Name" ./scripts/azure-setup.sh
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SUBSCRIPTION` | (current default) | Azure subscription name or ID |
| `VM_SIZE` | `Standard_B2ms` | Azure VM size |
| `ADMIN_USER` | `ewi` | SSH username |
| `ORCHA_PORT` | `3000` | Web dashboard port |
| `EXPOSE_PORT` | `false` | Open port to internet |

---

## Accessing the Dashboard

### Option 1: SSH Tunnel (Recommended)

Most secure - port 3000 is never exposed to the internet.

```bash
# Start the tunnel
./scripts/azure-manage.sh tunnel

# Opens: localhost:3000 -> VM:3000
# Access at http://localhost:3000
```

The tunnel stays open until you press `Ctrl+C`.

### Option 2: IP Whitelist

Allow access only from your current IP address.

```bash
# Whitelist your current IP
./scripts/azure-manage.sh whitelist

# Or specify an IP
./scripts/azure-manage.sh whitelist 203.0.113.50
```

Then access directly at `http://<vm-ip>:3000`

> **Note:** Your IP may change (home ISP, VPN, etc.). Re-run the command if you lose access.

### Option 3: Public Access

Open to anyone (not recommended for production).

```bash
# During setup
EXPOSE_PORT=true ./scripts/azure-setup.sh

# Or open manually via Azure CLI
az vm open-port -g orcha-rg -n orcha-dev --port 3000
```

### Comparison

| Method | Security | Setup | Access URL |
|--------|----------|-------|------------|
| SSH Tunnel | ★★★★★ | Run `tunnel` command | `localhost:3000` |
| IP Whitelist | ★★★★☆ | Run `whitelist` command | `<vm-ip>:3000` |
| Public | ★★☆☆☆ | Set `EXPOSE_PORT=true` | `<vm-ip>:3000` |

---

## Daily Management

### Code Sync

```bash
# Push local changes to VM
./scripts/azure-manage.sh sync

# Pull changes from VM to local
./scripts/azure-manage.sh pull
```

### Service Control

```bash
# Start/stop/restart Orcha
./scripts/azure-manage.sh start
./scripts/azure-manage.sh stop
./scripts/azure-manage.sh restart

# Check status
./scripts/azure-manage.sh status

# Stream logs
./scripts/azure-manage.sh logs
```

### SSH Access

```bash
# Regular SSH
./scripts/azure-manage.sh ssh

# Start a Claude Code session
./scripts/azure-manage.sh claude
```

### Cost Management

```bash
# Stop VM when not in use (no compute charges)
./scripts/azure-manage.sh vm-stop

# Start VM when needed
./scripts/azure-manage.sh vm-start

# Check VM state
./scripts/azure-manage.sh vm-status
```

> **Tip:** A deallocated VM costs $0 for compute. You only pay for storage (~$5/month).

---

## VM Commands Reference

```
./scripts/azure-manage.sh <command>

Connection:
  ssh             SSH into the VM
  tunnel          Secure tunnel to access dashboard
  claude          Start Claude Code tmux session

Code Sync:
  sync [path]     Push local code to VM
  pull [path]     Pull code from VM

Service:
  start           Start Orcha service
  stop            Stop Orcha service
  restart         Restart service
  status          Check service status
  logs            Stream service logs
  open            Open dashboard in browser

Security:
  whitelist [ip]  Restrict port to your IP
  lockdown        Close port 3000 entirely

Azure VM:
  vm-start        Start the VM
  vm-stop         Deallocate VM (save money)
  vm-status       Check VM power state
  info            Show connection details
  destroy         Delete VM (with confirmation)
```

---

## On the VM

After SSH-ing in, these scripts are available:

```bash
~/start-orcha.sh      # Build and start Orcha service
~/stop-orcha.sh       # Stop Orcha service
~/dev-orcha.sh        # Run in foreground (dev mode)
~/claude-session.sh   # Start Claude Code in tmux
```

### Service Management

```bash
# Systemd commands
sudo systemctl status orcha
sudo systemctl start orcha
sudo systemctl stop orcha
sudo systemctl restart orcha

# View logs
sudo journalctl -u orcha -f
```

### File Locations

| Path | Description |
|------|-------------|
| `~/projects/orcha/` | Orcha source code |
| `~/.claude/` | Claude Code config |
| `/etc/systemd/system/orcha.service` | Systemd service file |

---

## Troubleshooting

### Can't connect via SSH

```bash
# Check VM is running
./scripts/azure-manage.sh vm-status

# Start if stopped
./scripts/azure-manage.sh vm-start

# Check your SSH key
ssh -v ewi@<vm-ip>
```

### Orcha not loading

```bash
# Check service status
./scripts/azure-manage.sh status

# Check logs for errors
./scripts/azure-manage.sh logs

# Try running manually
./scripts/azure-manage.sh ssh
cd ~/projects/orcha
node dist/web/server.js
```

### Port not accessible

```bash
# If using tunnel, make sure it's running
./scripts/azure-manage.sh tunnel

# If using whitelist, your IP may have changed
./scripts/azure-manage.sh whitelist

# Check NSG rules in Azure Portal
az network nsg rule list -g orcha-rg --nsg-name <nsg-name> -o table
```

### VM IP changed after restart

```bash
# vm-start automatically updates the saved IP
./scripts/azure-manage.sh vm-start

# Or manually check
./scripts/azure-manage.sh info
```

---

## Cost Optimization

### Estimated Monthly Costs

| Resource | Running 24/7 | 8 hrs/day | Deallocated |
|----------|--------------|-----------|-------------|
| B2ms (2 vCPU, 8GB) | ~$60 | ~$20 | $0 |
| B4ms (4 vCPU, 16GB) | ~$120 | ~$40 | $0 |
| Storage (128GB) | $5 | $5 | $5 |

### Save Money

1. **Deallocate when not using**
   ```bash
   ./scripts/azure-manage.sh vm-stop
   ```

2. **Use smaller VM** - B2ms is enough for 1-2 Claude sessions

3. **Auto-shutdown** - Set up in Azure Portal:
   - VM → Auto-shutdown → Enable → Set time

4. **Reserved instances** - Save 30-50% with 1-year commitment

---

## Cleanup

### Delete Everything

```bash
./scripts/azure-manage.sh destroy
```

This will:
1. Delete the VM
2. Optionally delete the entire resource group
3. Remove local config file

### Manual Cleanup

```bash
# Delete just the VM
az vm delete -g orcha-rg -n orcha-dev --yes

# Delete entire resource group (everything)
az group delete -n orcha-rg --yes
```

---

## Quick Reference Card

```bash
# === SETUP ===
./scripts/azure-setup.sh                    # Create VM

# === DAILY USE ===
./scripts/azure-manage.sh tunnel            # Connect securely
./scripts/azure-manage.sh sync              # Push code
./scripts/azure-manage.sh start             # Start service
./scripts/azure-manage.sh logs              # View logs

# === SAVE MONEY ===
./scripts/azure-manage.sh vm-stop           # Stop when done
./scripts/azure-manage.sh vm-start          # Start next day

# === INFO ===
./scripts/azure-manage.sh info              # Show connection details
```
