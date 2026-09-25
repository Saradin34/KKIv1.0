#!/usr/bin/env bash
# Проверка C#-порта движка «Эхо-Цитадель».
#   ./tools/csharp/verify.sh            — собрать и сверить с TS-эталоном
#   ./tools/csharp/verify.sh --build-only — только сборка
#   ./tools/csharp/verify.sh --balance N SEED — прогон матчей (после порта движка)
# Требуется .NET SDK 8: по умолчанию ищем в ~/.dotnet (в песочнице он там).
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.dotnet:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1

MODE=verify
ARGS=()
case "${1:-}" in
  --build-only) MODE=build ;;
  --balance)    MODE=balance; shift; ARGS=("$@") ;;
  *)            ARGS=("$@") ;;
esac

if [ "$MODE" = build ]; then
  dotnet build tools/csharp/EchoCitadel.Tools.csproj -c Release -v q
else
  dotnet build tools/csharp/EchoCitadel.Tools.csproj -c Release -v q >/dev/null
  dotnet run --project tools/csharp/EchoCitadel.Tools.csproj -c Release --no-build -- "$MODE" "${ARGS[@]}"
fi
