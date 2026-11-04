#!/bin/bash
# Installs the helper once: bash native-host/install.sh <extension id>  (the settings page of My tutor shows the whole command).
# It copies the helper to ~/Library/Application Support/MEH English and tells Chrome this extension may use it.
set -e
ID="$1"
case "$ID" in
  [a-p][a-p]*) [ ${#ID} -eq 32 ] || { echo "That is not an extension id (32 letters a-p). Copy the command from the settings page."; exit 1; } ;;
  *) echo "Usage: bash native-host/install.sh <extension id>. Copy the command from the settings page of My tutor."; exit 1 ;;
esac
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$HOME/Library/Application Support/MEH English"
CHROME="${MEH_CHROME_DIR:-$HOME/Library/Application Support/Google/Chrome}/NativeMessagingHosts"
mkdir -p "$DIR" "$CHROME"
cp "$HERE/meh_vocab_host.py" "$DIR/meh_vocab_host.py"
chmod 755 "$DIR/meh_vocab_host.py"
cat > "$CHROME/com.meh.english_vocab.json" <<JSON
{
  "name": "com.meh.english_vocab",
  "description": "MEH English: saves the vocabulary database",
  "path": "$DIR/meh_vocab_host.py",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ID/"]
}
JSON
echo "Installed. Reload the extension: your words are now saved in ~/Documents/MEH English/vocabulary.json"
