#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
config_root="${1:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"

case "$config_root" in
  */opencode) ;;
  *)
    printf 'Refusing to install outside an OpenCode config directory: %s\n' "$config_root" >&2
    exit 1
    ;;
esac

plugin_dir="$config_root/plugins"
module_dir="$config_root/continuous-learning-plugin"
command_dir="$config_root/commands"
settings_dir="$config_root/continuous-learning"
backup_dir="$settings_dir/install-backups/$(date +%Y%m%d-%H%M%S)"

mkdir -p -- "$plugin_dir" "$module_dir" "$command_dir" "$settings_dir"

copy_with_backup() {
  source_path="$1"
  destination_path="$2"
  if [[ -e "$destination_path" ]]; then
    relative_path="${destination_path#"$config_root"/}"
    mkdir -p -- "$backup_dir/$(dirname -- "$relative_path")"
    cp -p -- "$destination_path" "$backup_dir/$relative_path"
  fi
  cp -- "$source_path" "$destination_path"
}

remove_with_backup() {
  destination_path="$1"
  if [[ ! -e "$destination_path" ]]; then
    return
  fi
  relative_path="${destination_path#"$config_root"/}"
  mkdir -p -- "$backup_dir/$(dirname -- "$relative_path")"
  cp -p -- "$destination_path" "$backup_dir/$relative_path"
  rm -f -- "$destination_path"
}

copy_with_backup "$project_root/install/continuous-learning.ts" "$plugin_dir/continuous-learning.ts"
copy_with_backup "$project_root/src/plugin.ts" "$module_dir/plugin.ts"
copy_with_backup "$project_root/src/core.ts" "$module_dir/core.ts"
copy_with_backup "$project_root/src/advanced.ts" "$module_dir/advanced.ts"
copy_with_backup "$project_root/src/tui.ts" "$module_dir/tui.ts"
copy_with_backup "$project_root/install/plugin-package.json" "$module_dir/package.json"
copy_with_backup "$project_root/commands/learn.md" "$command_dir/learn.md"
copy_with_backup "$project_root/commands/learn-review.md" "$command_dir/learn-review.md"
remove_with_backup "$command_dir/learning-mode.md"
copy_with_backup "$project_root/docs/用户手册.md" "$settings_dir/用户手册.md"

settings_path="$settings_dir/config.json"
if [[ ! -e "$settings_path" ]]; then
  cp -- "$project_root/config/default.json" "$settings_path"
fi

if [[ ! -f "$config_root/node_modules/@opencode-ai/plugin/package.json" ]]; then
  printf 'Warning: @opencode-ai/plugin is not installed under %s.\n' "$config_root" >&2
fi

if command -v bun >/dev/null 2>&1; then
  (cd -- "$module_dir" && bun install --production --ignore-scripts)
elif command -v npm >/dev/null 2>&1; then
  npm install --prefix "$module_dir" --omit=dev --ignore-scripts --no-audit --no-fund
else
  printf 'Warning: bun/npm was not found; Honcho provider support was not installed.\n' >&2
fi

if ! command -v opencode >/dev/null 2>&1; then
  printf 'OpenCode executable was not found; unable to register the TUI settings panel.\n' >&2
  exit 1
fi

for tui_config in "$config_root/tui.json" "$config_root/tui.jsonc"; do
  if [[ -e "$tui_config" ]]; then
    relative_path="${tui_config#"$config_root"/}"
    mkdir -p -- "$backup_dir/$(dirname -- "$relative_path")"
    cp -p -- "$tui_config" "$backup_dir/$relative_path"
  fi
done

XDG_CONFIG_HOME="${config_root%/opencode}" opencode plugin "$module_dir" --global --force

printf 'Installed plugin entry: %s\n' "$plugin_dir/continuous-learning.ts"
printf 'Installed settings panel: /learning-settings (also available in the command palette)\n'
printf 'Installed commands: %s, %s\n' "$command_dir/learn.md" "$command_dir/learn-review.md"
printf 'Settings: %s\n' "$settings_path"
printf 'User manual: %s\n' "$settings_dir/用户手册.md"
printf 'Restart OpenCode before using /learning-settings, /learning-pending, /learning-journey, /learn, or /learn-review.\n'
