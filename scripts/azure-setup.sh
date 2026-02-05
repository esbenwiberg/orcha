#!/bin/bash
#
# Orcha Azure VM Setup Script
# Creates an Azure Linux VM and fully configures it to run Orcha
#
# Usage: ./azure-setup.sh [resource-group] [vm-name] [location]
#
set -euo pipefail

# Configuration (override via environment or arguments)
RESOURCE_GROUP="${1:-orcha-rg}"
VM_NAME="${2:-orcha-dev}"
LOCATION="${3:-westeurope}"
VM_SIZE="${VM_SIZE:-Standard_B2ms}"
ADMIN_USER="${ADMIN_USER:-ewi}"
ORCHA_PORT="${ORCHA_PORT:-3000}"
EXPOSE_PORT="${EXPOSE_PORT:-false}"  # Don't expose publicly by default
SUBSCRIPTION="${SUBSCRIPTION:-}"     # Azure subscription name or ID

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; exit 1; }

# Check prerequisites
check_prerequisites() {
    log "Checking prerequisites..."

    if ! command -v az &> /dev/null; then
        error "Azure CLI not found. Install from: https://docs.microsoft.com/en-us/cli/azure/install-azure-cli"
    fi

    # Check if logged in
    if ! az account show &> /dev/null; then
        warn "Not logged into Azure. Starting login..."
        az login
    fi

    log "Logged in as: $(az account show --query user.name -o tsv)"

    # Handle subscription selection
    if [ -n "$SUBSCRIPTION" ]; then
        log "Setting subscription to: $SUBSCRIPTION"
        az account set --subscription "$SUBSCRIPTION" || error "Failed to set subscription: $SUBSCRIPTION"
    fi

    log "Subscription: $(az account show --query name -o tsv)"
    log "Subscription ID: $(az account show --query id -o tsv)"
}

# List available subscriptions
list_subscriptions() {
    log "Available subscriptions:"
    az account list --query "[].{Name:name, ID:id, Default:isDefault}" -o table
}

# Create resource group
create_resource_group() {
    log "Creating resource group '$RESOURCE_GROUP' in '$LOCATION'..."

    if az group show --name "$RESOURCE_GROUP" &> /dev/null; then
        warn "Resource group '$RESOURCE_GROUP' already exists, using it"
    else
        az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none
    fi
}

# Create the VM
create_vm() {
    log "Creating VM '$VM_NAME' (size: $VM_SIZE)..."

    if az vm show --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" &> /dev/null; then
        warn "VM '$VM_NAME' already exists"
        return
    fi

    az vm create \
        --resource-group "$RESOURCE_GROUP" \
        --name "$VM_NAME" \
        --image Ubuntu2404 \
        --size "$VM_SIZE" \
        --admin-username "$ADMIN_USER" \
        --generate-ssh-keys \
        --public-ip-sku Standard \
        --output none

    log "VM created successfully"
}

# Open ports for Orcha web dashboard
open_ports() {
    # SSH is always needed
    az vm open-port \
        --resource-group "$RESOURCE_GROUP" \
        --name "$VM_NAME" \
        --port 22 \
        --priority 1000 \
        --output none 2>/dev/null || true

    if [ "$EXPOSE_PORT" = "true" ]; then
        log "Opening port $ORCHA_PORT for Orcha web dashboard..."
        az vm open-port \
            --resource-group "$RESOURCE_GROUP" \
            --name "$VM_NAME" \
            --port "$ORCHA_PORT" \
            --priority 1010 \
            --output none
    else
        log "Port $ORCHA_PORT NOT exposed (secure mode)"
        log "Use SSH tunnel to access: ssh -L 3000:localhost:3000 user@vm-ip"
    fi
}

# Get VM's public IP
get_vm_ip() {
    az vm show \
        --resource-group "$RESOURCE_GROUP" \
        --name "$VM_NAME" \
        --show-details \
        --query publicIps \
        --output tsv
}

# Generate the cloud-init script that runs on first boot
generate_setup_script() {
    cat << 'SETUP_SCRIPT'
#!/bin/bash
#
# Orcha VM Configuration Script
# Runs on the Azure VM to install all dependencies
#
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

log() { echo "[$(date '+%H:%M:%S')] $1"; }

log "Starting Orcha setup..."

# Update system
log "Updating system packages..."
sudo apt-get update
sudo apt-get upgrade -y

# Install essential packages
log "Installing essential packages..."
sudo apt-get install -y \
    curl \
    git \
    tmux \
    build-essential \
    python3 \
    jq \
    unzip \
    htop

# Install GitHub CLI (needed for cloning repos)
log "Installing GitHub CLI..."
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt-get update
sudo apt-get install -y gh

# Install Node.js 20 LTS via NodeSource
log "Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify Node installation
log "Node.js version: $(node --version)"
log "npm version: $(npm --version)"

# Install Claude Code CLI
log "Installing Claude Code CLI..."
npm install -g @anthropic-ai/claude-code

# Create projects directory
mkdir -p ~/projects
cd ~/projects

# Clone Orcha (if not already present)
if [ ! -d "orcha" ]; then
    log "Cloning Orcha repository..."
    # Note: Update this URL to your actual repo
    git clone https://github.com/ewi/orcha.git orcha || {
        log "Creating orcha directory (clone failed, will need manual setup)"
        mkdir -p orcha
    }
fi

cd ~/projects/orcha

# Install dependencies if package.json exists
if [ -f "package.json" ]; then
    log "Installing Orcha dependencies..."
    npm install

    # Build TypeScript
    log "Building Orcha..."
    npm run build 2>/dev/null || npx tsc || true
fi

# Create systemd service for Orcha
log "Creating systemd service..."
sudo tee /etc/systemd/system/orcha.service > /dev/null << 'EOF'
[Unit]
Description=Orcha - Claude Code Orchestrator
After=network.target

[Service]
Type=simple
User=ewi
WorkingDirectory=/home/ewi/projects/orcha
ExecStart=/usr/bin/npm run web:dev
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd
sudo systemctl daemon-reload

# Create convenience scripts
log "Creating convenience scripts..."

# Start script
tee ~/start-orcha.sh > /dev/null << 'EOF'
#!/bin/bash
cd ~/projects/orcha
npm run build 2>/dev/null || npx tsc
sudo systemctl start orcha
sudo systemctl status orcha
EOF
chmod +x ~/start-orcha.sh

# Stop script
tee ~/stop-orcha.sh > /dev/null << 'EOF'
#!/bin/bash
sudo systemctl stop orcha
EOF
chmod +x ~/stop-orcha.sh

# Dev mode script (runs in foreground)
tee ~/dev-orcha.sh > /dev/null << 'EOF'
#!/bin/bash
cd ~/projects/orcha
npm run web:dev
EOF
chmod +x ~/dev-orcha.sh

# Web server in tmux (persistent)
tee ~/start-web.sh > /dev/null << 'EOF'
#!/bin/bash
cd ~/projects/orcha
tmux kill-session -t orcha-web 2>/dev/null || true
tmux new-session -d -s orcha-web "npm run web:dev"
echo "Orcha web server started in tmux session 'orcha-web'"
echo "View logs: tmux attach -t orcha-web"
echo "Dashboard: http://localhost:3000"
EOF
chmod +x ~/start-web.sh

# tmux session script for Claude Code
tee ~/claude-session.sh > /dev/null << 'EOF'
#!/bin/bash
SESSION_NAME="${1:-claude}"
cd ~/projects/orcha
tmux new-session -d -s "$SESSION_NAME" 2>/dev/null || tmux attach -t "$SESSION_NAME"
tmux send-keys -t "$SESSION_NAME" "claude" Enter
tmux attach -t "$SESSION_NAME"
EOF
chmod +x ~/claude-session.sh

# Create .claude directory for Claude Code config
mkdir -p ~/.claude

log "=========================================="
log "Orcha setup complete!"
log "=========================================="
log ""
log "IMPORTANT - Complete these steps:"
log "  1. gh auth login     - Authenticate GitHub CLI for cloning repos"
log "  2. Set ANTHROPIC_API_KEY in ~/.bashrc for Claude Code"
log ""
log "Quick start commands:"
log "  ~/start-web.sh      - Start Orcha web dashboard (in tmux)"
log "  ~/dev-orcha.sh      - Run in dev mode (foreground)"
log "  ~/claude-session.sh - Start a Claude Code tmux session"
log ""
log "Service management:"
log "  tmux attach -t orcha-web  - View web server logs"
log "  tmux ls                   - List all tmux sessions"
log ""
SETUP_SCRIPT
}

# Run setup on the VM via SSH
run_remote_setup() {
    local vm_ip="$1"

    log "Waiting for VM to be ready..."
    sleep 30

    # Wait for SSH to be available
    local retries=0
    while ! ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "${ADMIN_USER}@${vm_ip}" "echo ready" &> /dev/null; do
        retries=$((retries + 1))
        if [ $retries -gt 30 ]; then
            error "Timeout waiting for SSH"
        fi
        log "Waiting for SSH... (attempt $retries/30)"
        sleep 10
    done

    log "SSH is available, running setup script..."

    # Generate and run the setup script
    generate_setup_script | ssh -o StrictHostKeyChecking=no "${ADMIN_USER}@${vm_ip}" "bash -s"
}

# Main execution
main() {
    echo ""
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║          Orcha Azure VM Setup Script                      ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo ""

    # Check login first to show subscription info
    if ! command -v az &> /dev/null; then
        error "Azure CLI not found. Install from: https://docs.microsoft.com/en-us/cli/azure/install-azure-cli"
    fi

    if ! command -v jq &> /dev/null; then
        error "jq not found. Install with: sudo apt-get install -y jq"
    fi

    if ! az account show &> /dev/null; then
        warn "Not logged into Azure. Starting login..."
        az login
    fi

    # Show available subscriptions if multiple exist
    local sub_count=$(az account list --query "length([])" -o tsv)
    if [ "$sub_count" -gt 1 ] && [ -z "$SUBSCRIPTION" ]; then
        echo "Available Azure Subscriptions:"
        az account list --query "[].{Name:name, ID:id, Default:isDefault}" -o table
        echo ""
        warn "Multiple subscriptions found. Current default will be used."
        echo "  To use a different subscription, set SUBSCRIPTION env var:"
        echo "  SUBSCRIPTION='My Subscription Name' ./scripts/azure-setup.sh"
        echo ""
    fi

    # Set subscription if specified
    if [ -n "$SUBSCRIPTION" ]; then
        log "Setting subscription to: $SUBSCRIPTION"
        az account set --subscription "$SUBSCRIPTION" || error "Failed to set subscription: $SUBSCRIPTION"
    fi

    local current_sub=$(az account show --query name -o tsv)
    local current_sub_id=$(az account show --query id -o tsv)

    echo "Configuration:"
    echo "  Subscription:   $current_sub"
    echo "  Subscription ID: $current_sub_id"
    echo "  Resource Group: $RESOURCE_GROUP"
    echo "  VM Name:        $VM_NAME"
    echo "  Location:       $LOCATION"
    echo "  VM Size:        $VM_SIZE"
    echo "  Admin User:     $ADMIN_USER"
    echo "  Orcha Port:     $ORCHA_PORT"
    echo "  Expose Port:    $EXPOSE_PORT (set EXPOSE_PORT=true to open publicly)"
    echo ""

    read -p "Continue with this configuration? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 0
    fi

    log "Logged in as: $(az account show --query user.name -o tsv)"
    log "Using subscription: $current_sub"
    create_resource_group
    create_vm
    open_ports

    VM_IP=$(get_vm_ip)
    log "VM Public IP: $VM_IP"

    run_remote_setup "$VM_IP"

    echo ""
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║                    Setup Complete!                        ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo ""
    echo "VM Details:"
    echo "  Public IP:    $VM_IP"
    echo "  SSH Command:  ssh ${ADMIN_USER}@${VM_IP}"
    echo ""
    echo "Access Orcha (secure via SSH tunnel):"
    echo "  ./scripts/azure-manage.sh tunnel"
    echo "  Then open: http://localhost:${ORCHA_PORT}"
    if [ "$EXPOSE_PORT" = "true" ]; then
        echo ""
        echo "  Or directly: http://${VM_IP}:${ORCHA_PORT}"
    fi
    echo ""
    echo "Next steps:"
    echo "  1. SSH into the VM:  ssh ${ADMIN_USER}@${VM_IP}"
    echo "  2. Copy your Orcha code or configure git remote"
    echo "  3. Set up Claude API key:  export ANTHROPIC_API_KEY=..."
    echo "  4. Start Orcha:  ~/start-orcha.sh"
    echo ""
    echo "To sync your local code to the VM:"
    echo "  rsync -avz --exclude node_modules --exclude dist \\"
    echo "    ~/projects/orcha/ ${ADMIN_USER}@${VM_IP}:~/projects/orcha/"
    echo ""

    # Save connection info locally
    mkdir -p ~/.orcha
    cat > ~/.orcha/azure-vm.json << EOF
{
  "resourceGroup": "$RESOURCE_GROUP",
  "vmName": "$VM_NAME",
  "location": "$LOCATION",
  "publicIp": "$VM_IP",
  "adminUser": "$ADMIN_USER",
  "orchaPort": "$ORCHA_PORT",
  "sshCommand": "ssh ${ADMIN_USER}@${VM_IP}",
  "orchaUrl": "http://${VM_IP}:${ORCHA_PORT}",
  "createdAt": "$(date -Iseconds)"
}
EOF
    log "Connection info saved to ~/.orcha/azure-vm.json"
}

main "$@"
