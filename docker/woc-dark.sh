#!/bin/bash
# 实时切换本实例桌面深色（由面板经 docker exec 以 app 用户身份调用：woc-dark.sh on|off）。
# 原理：改 GNOME color-scheme（dconf 共享后端）→ 与 autostart 同一条 session 总线上的 xdg-desktop-portal
# 收到变化、对外发 org.freedesktop.appearance→color-scheme 的 SettingChanged → 微信等 Chromium 系应用实时重绘。
# 须与 autostart 用完全相同的 XDG_RUNTIME_DIR / 总线地址，否则改的不是同一个 dconf、portal 读不到。
set -u

uid="$(id -u)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/woc-run-${uid}}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/woc-bus}"

case "${1:-}" in
    on | 1 | dark | true)
        scheme='prefer-dark'
        gtk='Adwaita-dark'
        ;;
    *)
        scheme='default'
        gtk='Adwaita'
        ;;
esac

command -v gsettings >/dev/null 2>&1 || {
    echo "[woc-dark] 容器内无 gsettings（镜像未升级到含 portal 的版本），跳过；重启实例即用新镜像生效" >&2
    exit 1
}

gsettings set org.gnome.desktop.interface color-scheme "$scheme" 2>/dev/null || {
    echo "[woc-dark] 设置 color-scheme 失败（portal/总线可能未就绪），可重启实例" >&2
    exit 1
}
gsettings set org.gnome.desktop.interface gtk-theme "$gtk" 2>/dev/null || true
echo "[woc-dark] color-scheme=${scheme}"
