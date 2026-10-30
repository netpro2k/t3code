#!/bin/bash
set -euo pipefail
umask 077

if [[ $(uname -s) != Darwin ]]; then
  echo "Fork signing setup runs on the Mac build host." >&2
  exit 1
fi
mode=${1:-}
directory=${2:-$HOME/.config/t3code/signing}
if [[ "$directory" != /* ]] || [[ $# -gt 2 ]]; then
  echo "Usage: fork-signing.sh <setup|unlock> [/absolute/private/directory]" >&2
  exit 2
fi
# Quotes/newlines are disallowed because security's interactive parser reads the path.
if [[ "$directory" == *\"* || "$directory" == *$'\n'* || "$directory" == *\\* ]]; then
  echo "Use a signing directory without quotes, backslashes or newlines." >&2
  exit 1
fi

keychain="$directory/signing.keychain-db"
password_file="$directory/keychain-password"
identity_name="netpro2k T3 Code Updates"

unlock() {
  [[ -f "$password_file" && -f "$keychain" ]] || {
    echo "Signing keychain is incomplete; run setup once." >&2
    return 1
  }
  [[ $(stat -f '%Lp' "$directory") == 700 && $(stat -f '%Lp' "$password_file") == 600 ]] || {
    echo "Signing directory/password permissions must be 700/600." >&2
    return 1
  }
  password=$(cat "$password_file")
  [[ "$password" =~ ^[0-9a-f]{64}$ ]] || {
    echo "Invalid signing password file." >&2
    return 1
  }
  # Feed the secret over stdin, keeping it out of process arguments and build logs.
  printf 'unlock-keychain -p %s "%s"\n' "$password" "$keychain" |
    security -i >/dev/null 2>&1
  unset password
}

case "$mode" in
  setup)
    if [[ -e "$directory" ]]; then
      [[ -f "$directory/environment.sh" && -f "$directory/identity.pem" ]] || {
        echo "Refusing to overwrite an existing incomplete signing directory." >&2
        exit 1
      }
      unlock
      echo "Using the existing signing identity in $directory"
      exit 0
    fi
    mkdir -p "$(dirname "$directory")"
    mkdir -m 700 "$directory"
    complete=false
    cleanup() {
      if [[ "$complete" != true ]]; then
        security delete-keychain "$keychain" >/dev/null 2>&1 || true
        rm -rf "$directory"
      fi
    }
    trap cleanup EXIT
    openssl rand -hex 32 | tr -d '\n' > "$password_file"
    cat > "$directory/certificate.cnf" <<'CONFIG'
[req]
prompt = no
distinguished_name = dn
x509_extensions = codesign
[dn]
CN = netpro2k T3 Code Updates
[codesign]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
CONFIG
    openssl req -new -newkey rsa:3072 -nodes -x509 -days 3650 \
      -config "$directory/certificate.cnf" -keyout "$directory/key.pem" \
      -out "$directory/certificate.pem" >/dev/null 2>&1
    openssl pkcs8 -topk8 -v2 aes-256-cbc -in "$directory/key.pem" \
      -out "$directory/identity.pem" -passout "file:$password_file"
    openssl pkcs12 -export -inkey "$directory/key.pem" -in "$directory/certificate.pem" \
      -out "$directory/identity.p12" -passout "file:$password_file"
    password=$(cat "$password_file")
    # security -i receives commands privately; none of these values enter argv or logs.
    security -i >/dev/null 2>&1 <<COMMANDS
create-keychain -p $password "$keychain"
unlock-keychain -p $password "$keychain"
import "$directory/identity.p12" -k "$keychain" -P $password -T /usr/bin/codesign
set-key-partition-list -S apple-tool:,apple:,codesign: -s -k $password "$keychain"
set-keychain-settings -lut 21600 "$keychain"
COMMANDS
    unset password
    unlock
    cp /usr/bin/true "$directory/check-first"
    cp /usr/bin/false "$directory/check-second"
    for file in check-first check-second; do
      codesign --force --sign "$identity_name" --keychain "$keychain" \
        --identifier com.t3tools.t3code --options runtime --timestamp "$directory/$file"
      codesign --verify --deep --strict "$directory/$file"
    done
    codesign -d -r- "$directory/check-first" > "$directory/requirement" 2>&1
    requirement=$(sed -n 's/^designated => //p' "$directory/requirement")
    [[ -n "$requirement" ]]
    codesign --verify --deep --strict -R "=$requirement" "$directory/check-second"
    fingerprint=$(openssl x509 -in "$directory/certificate.pem" -noout -fingerprint -sha1 |
      sed 's/.*=//; s/://g')
    [[ "$fingerprint" =~ ^[0-9A-Fa-f]{40}$ ]]
    {
      printf 'export T3CODE_SIGNING_DIRECTORY=%q\n' "$directory"
      printf 'export CSC_KEYCHAIN=%q\n' "$keychain"
      printf 'export T3CODE_CLI_MAC_SIGN_IDENTITY=%q\n' "$fingerprint"
    } > "$directory/environment.sh"
    rm -f "$directory/identity.p12" "$directory/key.pem" "$directory/check-first" "$directory/check-second" \
      "$directory/requirement" "$directory/certificate.cnf"
    complete=true
    trap - EXIT
    echo "Created and verified the private fork signing identity in $directory"
    echo "Source $directory/environment.sh before the Mac release build."
    ;;
  unlock)
    unlock
    ;;
  *)
    echo "Usage: fork-signing.sh <setup|unlock> [/absolute/private/directory]" >&2
    exit 2
    ;;
esac
