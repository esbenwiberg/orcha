#!/bin/bash
#
# Orcha Azure VM Management Script
# Helper commands for managing your Orcha Azure VM
#
# Usage: ./azure-manage.sh <command>
#
set -euo pipefail

CONFIG_FILE="${HOME}/.orcha/azure-vm.json"

# Check for jq dependency
if ! command -v jq &> /dev/null; then
    echo "Error: jq is required. Install with: sudo apt-get install -y jq"
    exit 1
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; exit 1; }

# Load config
load_config() {
    if [ ! -f "$CONFIG_FILE" ]; then
        error "Config not found. Run azure-setup.sh first."
    fi

    VM_IP=$(jq -r '.publicIp' "$CONFIG_FILE")
    ADMIN_USER=$(jq -r '.adminUser' "$CONFIG_FILE")
    RESOURCE_GROUP=$(jq -r '.resourceGroup' "$CONFIG_FILE")
    VM_NAME=$(jq -r '.vmName' "$CONFIG_FILE")
    ORCHA_PORT=$(jq -r '.orchaPort' "$CONFIG_FILE")
}

# Commands
cmd_ssh() {
    load_config
    log "Connecting to $VM_IP..."
    ssh "${ADMIN_USER}@${VM_IP}"
}

cmd_tunnel() {
    load_config
    log "Opening SSH tunnel: localhost:${ORCHA_PORT} -> VM:${ORCHA_PORT}"
    log "Access Orcha at: http://localhost:${ORCHA_PORT}"
    log "Press Ctrl+C to close tunnel"
    ssh -N -L "${ORCHA_PORT}:localhost:${ORCHA_PORT}" "${ADMIN_USER}@${VM_IP}"
}

cmd_sync() {
    load_config
    local src="${1:-$(pwd)}"

    log "Syncing $src to VM..."
    rsync -avz --progress \
        --exclude 'node_modules' \
        --exclude '.git' \
        --exclude '*.log' \
        "$src/" "${ADMIN_USER}@${VM_IP}:~/projects/orcha/"

    log "Running npm install and build on VM..."
    ssh "${ADMIN_USER}@${VM_IP}" "cd ~/projects/orcha && npm install && npm run build"

    log "Sync complete!"
}

cmd_deploy() {
    load_config

    log "Building locally..."
    npm run build

    log "Syncing to VM..."
    rsync -avz --progress \
        --exclude 'node_modules' \
        --exclude '.git' \
        --exclude '*.log' \
        "$(pwd)/" "${ADMIN_USER}@${VM_IP}:~/projects/orcha/"

    log "Installing dependencies on VM..."
    ssh "${ADMIN_USER}@${VM_IP}" "cd ~/projects/orcha && npm install"

    log "Restarting server..."
    ssh "${ADMIN_USER}@${VM_IP}" "tmux kill-session -t orcha-web 2>/dev/null || true; tmux new-session -d -s orcha-web 'cd ~/projects/orcha && npm run web:dev'"

    sleep 2
    log "Verifying server..."
    ssh "${ADMIN_USER}@${VM_IP}" "curl -s http://localhost:3000 | head -1" && log "Server is running!"

    log "Deploy complete! Access via: ./scripts/azure-manage.sh tunnel"
}

cmd_pull() {
    load_config
    local dest="${1:-$(pwd)}"

    log "Pulling from VM to $dest..."
    rsync -avz --progress \
        --exclude 'node_modules' \
        --exclude 'dist' \
        "${ADMIN_USER}@${VM_IP}:~/projects/orcha/" "$dest/"

    log "Pull complete!"
}

cmd_start() {
    load_config
    log "Starting Orcha service on VM..."
    ssh "${ADMIN_USER}@${VM_IP}" "sudo systemctl start orcha && sudo systemctl status orcha"
    echo ""
    log "Orcha available at: http://${VM_IP}:${ORCHA_PORT}"
}

cmd_stop() {
    load_config
    log "Stopping Orcha service on VM..."
    ssh "${ADMIN_USER}@${VM_IP}" "sudo systemctl stop orcha"
}

cmd_restart() {
    load_config
    log "Restarting Orcha service on VM..."
    ssh "${ADMIN_USER}@${VM_IP}" "sudo systemctl restart orcha && sudo systemctl status orcha"
}

cmd_status() {
    load_config
    log "Checking Orcha status..."
    ssh "${ADMIN_USER}@${VM_IP}" "sudo systemctl status orcha" || true
}

cmd_logs() {
    load_config
    log "Streaming Orcha logs (Ctrl+C to stop)..."
    ssh "${ADMIN_USER}@${VM_IP}" "sudo journalctl -u orcha -f"
}

cmd_open() {
    load_config
    local url="http://${VM_IP}:${ORCHA_PORT}"
    log "Opening $url..."

    # Try different openers
    if command -v xdg-open &> /dev/null; then
        xdg-open "$url"
    elif command -v open &> /dev/null; then
        open "$url"
    elif command -v wslview &> /dev/null; then
        wslview "$url"
    elif [ -f "/mnt/c/Windows/System32/cmd.exe" ]; then
        /mnt/c/Windows/System32/cmd.exe /c start "$url"
    else
        echo "Open in browser: $url"
    fi
}

cmd_vm_start() {
    load_config
    log "Starting Azure VM..."
    az vm start --resource-group "$RESOURCE_GROUP" --name "$VM_NAME"

    # Update IP in case it changed
    NEW_IP=$(az vm show --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --show-details --query publicIps -o tsv)
    if [ "$NEW_IP" != "$VM_IP" ]; then
        warn "IP changed from $VM_IP to $NEW_IP"
        jq --arg ip "$NEW_IP" '.publicIp = $ip' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
    fi
    log "VM started. IP: $NEW_IP"
}

cmd_vm_stop() {
    load_config
    log "Stopping Azure VM (deallocating to save costs)..."
    az vm deallocate --resource-group "$RESOURCE_GROUP" --name "$VM_NAME"
    log "VM deallocated. No compute charges while stopped."
}

cmd_vm_status() {
    load_config
    log "Azure VM status:"
    az vm show --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --show-details \
        --query "{name:name, state:powerState, ip:publicIps, size:hardwareProfile.vmSize}" \
        -o table
}

cmd_info() {
    load_config
    echo ""
    echo -e "${CYAN}Orcha Azure VM Info${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  VM Name:        $VM_NAME"
    echo "  Resource Group: $RESOURCE_GROUP"
    echo "  Public IP:      $VM_IP"
    echo "  Admin User:     $ADMIN_USER"
    echo "  Orcha Port:     $ORCHA_PORT"
    echo ""
    echo "  SSH:    ssh ${ADMIN_USER}@${VM_IP}"
    echo "  URL:    http://${VM_IP}:${ORCHA_PORT}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

cmd_whitelist() {
    load_config

    # Get user's current public IP
    local my_ip="${1:-$(curl -s ifconfig.me)}"

    if [ -z "$my_ip" ]; then
        error "Could not detect your IP. Pass it as argument: $0 whitelist <your-ip>"
    fi

    log "Restricting port $ORCHA_PORT to IP: $my_ip"

    # Get NSG name
    local nsg_name=$(az network nsg list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv)

    if [ -z "$nsg_name" ]; then
        error "Could not find Network Security Group"
    fi

    # Update or create rule to only allow your IP
    az network nsg rule update \
        --resource-group "$RESOURCE_GROUP" \
        --nsg-name "$nsg_name" \
        --name "open-port-${ORCHA_PORT}" \
        --source-address-prefixes "$my_ip" \
        --output none 2>/dev/null || \
    az network nsg rule create \
        --resource-group "$RESOURCE_GROUP" \
        --nsg-name "$nsg_name" \
        --name "orcha-whitelist" \
        --priority 1010 \
        --destination-port-ranges "$ORCHA_PORT" \
        --source-address-prefixes "$my_ip" \
        --access Allow \
        --protocol Tcp \
        --output none

    log "Done! Port $ORCHA_PORT now only accessible from $my_ip"
    warn "Your IP may change. Re-run this command if you lose access."
}

cmd_lockdown() {
    load_config
    log "Removing public access to port $ORCHA_PORT..."

    local nsg_name=$(az network nsg list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv)

    # Delete the open port rule
    az network nsg rule delete \
        --resource-group "$RESOURCE_GROUP" \
        --nsg-name "$nsg_name" \
        --name "open-port-${ORCHA_PORT}" \
        --output none 2>/dev/null || true

    az network nsg rule delete \
        --resource-group "$RESOURCE_GROUP" \
        --nsg-name "$nsg_name" \
        --name "orcha-whitelist" \
        --output none 2>/dev/null || true

    log "Port $ORCHA_PORT is now closed. Use 'tunnel' command to access Orcha."
}

cmd_destroy() {
    load_config

    echo ""
    warn "This will DELETE the Azure VM and all its data!"
    echo "  Resource Group: $RESOURCE_GROUP"
    echo "  VM Name:        $VM_NAME"
    echo ""
    read -p "Type 'DELETE' to confirm: " confirm

    if [ "$confirm" != "DELETE" ]; then
        log "Aborted."
        exit 0
    fi

    log "Deleting VM..."
    az vm delete --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --yes

    log "Cleaning up related resources..."
    # Delete NIC, disk, NSG, public IP
    az resource list --resource-group "$RESOURCE_GROUP" --query "[].{name:name, type:type}" -o table

    read -p "Delete entire resource group '$RESOURCE_GROUP'? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        az group delete --name "$RESOURCE_GROUP" --yes --no-wait
        log "Resource group deletion initiated."
    fi

    rm -f "$CONFIG_FILE"
    log "Local config removed."
}

cmd_claude() {
    load_config
    log "Starting Claude Code session on VM..."
    ssh -t "${ADMIN_USER}@${VM_IP}" "~/claude-session.sh"
}

# Help
show_help() {
    cat << EOF
Orcha Azure VM Management

Usage: $(basename "$0") <command>

Connection Commands:
  ssh           SSH into the VM
  tunnel        SSH tunnel to access Orcha securely (no public port needed)
  claude        Start a Claude Code tmux session on VM

Code Sync Commands:
  sync [path]   Sync local code to VM and build
  pull [path]   Pull code from VM to local
  deploy        Build, sync, and restart server (one command!)

Orcha Service Commands:
  start         Start Orcha service
  stop          Stop Orcha service
  restart       Restart Orcha service
  status        Check service status
  logs          Stream service logs
  open          Open Orcha in browser

Security Commands:
  tunnel        Access Orcha via SSH tunnel (most secure)
  whitelist     Restrict port 3000 to your current IP only
  lockdown      Close port 3000 entirely (use tunnel instead)

Azure VM Commands:
  vm-start      Start the Azure VM
  vm-stop       Stop/deallocate VM (saves money)
  vm-status     Check Azure VM status
  info          Show connection info
  destroy       Delete the VM (with confirmation)

Examples:
  $(basename "$0") ssh              # Connect to VM
  $(basename "$0") sync             # Push local changes
  $(basename "$0") start            # Start Orcha service
  $(basename "$0") vm-stop          # Deallocate when not in use
EOF
}

# Main
case "${1:-help}" in
    ssh)        cmd_ssh ;;
    tunnel)     cmd_tunnel ;;
    sync)       cmd_sync "${2:-}" ;;
    pull)       cmd_pull "${2:-}" ;;
    deploy)     cmd_deploy ;;
    start)      cmd_start ;;
    stop)       cmd_stop ;;
    restart)    cmd_restart ;;
    status)     cmd_status ;;
    logs)       cmd_logs ;;
    open)       cmd_open ;;
    whitelist)  cmd_whitelist "${2:-}" ;;
    lockdown)   cmd_lockdown ;;
    vm-start)   cmd_vm_start ;;
    vm-stop)    cmd_vm_stop ;;
    vm-status)  cmd_vm_status ;;
    info)       cmd_info ;;
    destroy)    cmd_destroy ;;
    claude)     cmd_claude ;;
    help|--help|-h) show_help ;;
    *)          error "Unknown command: $1. Use --help for usage." ;;
esac
