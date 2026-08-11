#!/usr/bin/env bash

preserve_hashed_assets() {
  if [[ "$#" -ne 2 ]]; then
    echo "用法：preserve_hashed_assets <releases-root> <target-release>" >&2
    return 64
  fi

  local releases_root="${1%/}"
  local target_release="${2%/}"
  local target_assets="$target_release/dist/client/assets"
  # Vite/Rollup uses URL-safe base64-like hashes (for example D_sgeZzU), not hex only.
  local hashed_asset_pattern='^[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9_-]{8,64}\.(js|css)$'
  local source_release source_assets source_file asset_name destination temporary
  local preserved=0

  if [[ ! -d "$releases_root" || -L "$releases_root" ]]; then
    echo "历史发布根目录无效或为符号链接：$releases_root" >&2
    return 1
  fi
  if [[ "${target_release%/*}" != "$releases_root" ]]; then
    echo "新发布目录必须是历史发布根目录的直接子目录：$target_release" >&2
    return 1
  fi
  if [[ ! -d "$target_release" || -L "$target_release"
    || ! -d "$target_release/dist" || -L "$target_release/dist"
    || ! -d "$target_release/dist/client" || -L "$target_release/dist/client"
    || ! -d "$target_assets" || -L "$target_assets" ]]; then
    echo "新发布的静态资源目录无效或包含符号链接：$target_assets" >&2
    return 1
  fi

  for source_release in "$releases_root"/*; do
    [[ "$source_release" != "$target_release" ]] || continue
    [[ -d "$source_release" && ! -L "$source_release" ]] || continue

    source_assets="$source_release/dist/client/assets"
    [[ -d "$source_release/dist" && ! -L "$source_release/dist" ]] || continue
    [[ -d "$source_release/dist/client" && ! -L "$source_release/dist/client" ]] || continue
    [[ -d "$source_assets" && ! -L "$source_assets" ]] || continue

    for source_file in "$source_assets"/*; do
      [[ -f "$source_file" && ! -L "$source_file" ]] || continue
      asset_name="${source_file##*/}"
      [[ "$asset_name" =~ $hashed_asset_pattern ]] || continue

      destination="$target_assets/$asset_name"
      [[ ! -e "$destination" && ! -L "$destination" ]] || continue

      if ! temporary="$(mktemp "$target_assets/.preserve-asset.XXXXXX")"; then
        echo "无法为历史静态资源创建临时文件：$destination" >&2
        return 1
      fi
      if ! cp -- "$source_file" "$temporary"; then
        rm -f -- "$temporary"
        echo "复制历史静态资源失败：$source_file" >&2
        return 1
      fi
      if ! chmod 0644 "$temporary"; then
        rm -f -- "$temporary"
        echo "设置历史静态资源权限失败：$temporary" >&2
        return 1
      fi

      if [[ -e "$destination" || -L "$destination" ]]; then
        rm -f -- "$temporary"
        continue
      fi
      if ! mv -n -- "$temporary" "$destination"; then
        rm -f -- "$temporary"
        echo "保留历史静态资源失败：$destination" >&2
        return 1
      fi
      if [[ -e "$temporary" || -L "$temporary" ]]; then
        rm -f -- "$temporary"
        continue
      fi
      if [[ ! -f "$destination" || -L "$destination" ]]; then
        echo "历史静态资源落盘校验失败：$destination" >&2
        return 1
      fi
      preserved=$((preserved + 1))
    done
  done

  echo "已为新发布保留 $preserved 个历史哈希静态资源"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -Eeuo pipefail
  preserve_hashed_assets "$@"
fi
