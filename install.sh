#!/usr/bin/env bash
#
# Orcha installer - One-command setup for the parallel AI orchestrator
# Usage: curl -fsSL https://raw.githubusercontent.com/esbenwiberg/orcha/main/install.sh | bash
#

set -e

ORCHA_REPO="https://github.com/esbenwiberg/orcha.git"
INSTALL_DIR="$HOME/.orcha-cli"
BOLD=$(tput bold 2>/dev/null || echo '')
RESET=$(tput sgr0 2>/dev/null || echo '')
GREEN=$(tput setaf 2 2>/dev/null || echo '')
YELLOW=$(tput setaf 3 2>/dev/null || echo '')
RED=$(tput setaf 1 2>/dev/null || echo '')

echo "${BOLD}Orcha Installer${RESET}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check for Node.js
echo "→ Checking Node.js..."
if ! command -v node >/dev/null 2>&1; then
    echo "${RED}✗ Node.js not found${RESET}"
    echo ""
    echo "Please install Node.js 20+ first:"
    echo "  https://nodejs.org"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "${RED}✗ Node.js $NODE_VERSION found, but 20+ required${RESET}"
    echo ""
    echo "Please upgrade Node.js:"
    echo "  https://nodejs.org"
    exit 1
fi

echo "${GREEN}✓ Node.js $(node -v) found${RESET}"

# Check for tmux
echo "→ Checking tmux..."
if ! command -v tmux >/dev/null 2>&1; then
    echo "${YELLOW}⚠ tmux not found${RESET}"
    echo ""
    echo "tmux is required for session management."
    echo ""

    # Offer to install on Linux
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        if command -v apt-get >/dev/null 2>&1; then
            read -p "Install tmux now? (y/n) " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                sudo apt-get update && sudo apt-get install -y tmux
            else
                echo "${RED}Installation cancelled${RESET}"
                exit 1
            fi
        else
            echo "Please install tmux:"
            echo "  Ubuntu/Debian: sudo apt install tmux"
            echo "  Fedora: sudo dnf install tmux"
            exit 1
        fi
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        echo "Please install tmux:"
        echo "  brew install tmux"
        exit 1
    else
        echo "Please install tmux for your platform"
        exit 1
    fi
fi

echo "${GREEN}✓ tmux $(tmux -V) found${RESET}"

# Configure tmux for mouse support
echo "→ Configuring tmux mouse support..."
TMUX_CONF="$HOME/.tmux.conf"
if [ -f "$TMUX_CONF" ] && grep -q "set.*mouse" "$TMUX_CONF"; then
    echo "${GREEN}✓ Mouse support already configured${RESET}"
else
    echo "set -g mouse on" >> "$TMUX_CONF"
    echo "${GREEN}✓ Added mouse support to ~/.tmux.conf${RESET}"
    # Reload tmux config if tmux server is running
    if tmux list-sessions >/dev/null 2>&1; then
        tmux source-file "$TMUX_CONF" 2>/dev/null || true
    fi
fi

# Check for Claude Code (optional)
echo "→ Checking AI CLI tools..."
HAS_AI=false
if command -v claude >/dev/null 2>&1; then
    echo "${GREEN}✓ Claude Code found${RESET}"
    HAS_AI=true
fi
if command -v gemini >/dev/null 2>&1; then
    echo "${GREEN}✓ Gemini CLI found${RESET}"
    HAS_AI=true
fi
if command -v codex >/dev/null 2>&1; then
    echo "${GREEN}✓ Codex CLI found${RESET}"
    HAS_AI=true
fi

if [ "$HAS_AI" = false ]; then
    echo "${YELLOW}⚠ No AI CLI tools found${RESET}"
    echo ""
    echo "Orcha needs at least one AI tool:"
    echo "  • Claude Code: https://claude.ai/claude-code"
    echo "  • Gemini CLI: https://github.com/google/gemini-cli"
    echo "  • Codex CLI: https://github.com/openai/codex-cli"
    echo ""
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "${RED}Installation cancelled${RESET}"
        exit 1
    fi
fi

echo ""
echo "→ Installing Orcha..."

# Remove old installation
if [ -d "$INSTALL_DIR" ]; then
    echo "  Removing old installation..."
    rm -rf "$INSTALL_DIR"
fi

# Clone repo
echo "  Cloning repository..."
git clone --quiet --depth 1 "$ORCHA_REPO" "$INSTALL_DIR"

# Install dependencies
echo "  Installing dependencies..."
cd "$INSTALL_DIR"
npm install --quiet --no-progress

# Build
echo "  Building..."
npm run build --silent

# Link globally
echo "  Linking globally..."
npm link --quiet

echo ""
echo "${GREEN}${BOLD}✓ Orcha installed successfully!${RESET}"
echo ""
echo "Try it out:"
echo "  ${BOLD}orcha start -n 3 -r ~/your-project${RESET}"
echo "  ${BOLD}orcha web${RESET}  (open web dashboard)"
echo ""
echo "Run ${BOLD}orcha --help${RESET} for more commands"
echo ""
