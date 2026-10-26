#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scripts/embed-binaries.py —— 将全架构二进制矩阵内嵌进 main 分支的插件目录
确保用户通过自定义市场（custom market 本地打包机制）安装插件时，
插件体内天然自带对应平台与芯片架构的原生可执行程序，实现各架构自动适配与开箱即用。
"""

import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "upstream"

CUBE_MAP = {
    "darwin-arm64": ("cube-cli-aarch64-macos", "cube-cli"),
    "darwin-x64":   ("cube-cli-x86_64-macos",  "cube-cli"),
    "win32-x64":     ("cube-cli-x86_64-windows-gnu.exe", "cube-cli.exe"),
    "win32-arm64":   ("cube-cli-aarch64-windows-gnu.exe", "cube-cli.exe"),
    "linux-x64":     ("cube-cli-x86_64-linux-musl", "cube-cli"),
    "linux-arm64":   ("cube-cli-aarch64-linux-musl", "cube-cli"),
}

AIOD_MAP = {
    "darwin-arm64": ("aiod-cli-aarch64-macos", "aiod-cli"),
    "darwin-x64":   ("aiod-cli-x86_64-macos",  "aiod-cli"),
    "linux-x64":     ("aiod-cli-x86_64-linux-musl", "aiod-cli"),
    "linux-arm64":   ("aiod-cli-aarch64-linux-musl", "aiod-cli"),
}

def embed():
    print("=== 内嵌全架构二进制矩阵到 plugins/ 目录 ===")
    
    # Cube CLI
    cube_bin_root = ROOT / "plugins" / "cube-cli" / "bin"
    for plat, (art, name) in CUBE_MAP.items():
        dest_dir = cube_bin_root / plat
        dest_dir.mkdir(parents=True, exist_ok=True)
        src = CACHE / "cube-cli" / art
        if src.exists():
            dest = dest_dir / name
            shutil.copy2(src, dest)
            if not name.endswith(".exe"):
                dest.chmod(0o755)
            print(f"  [Cube] 内嵌: {plat}/{name} ({dest.stat().st_size} bytes)")
        else:
            print(f"  [WARN] 未找到缓存产物: {src}")

    # Aiod CLI
    aiod_bin_root = ROOT / "plugins" / "aiod-cli" / "bin"
    for plat, (art, name) in AIOD_MAP.items():
        dest_dir = aiod_bin_root / plat
        dest_dir.mkdir(parents=True, exist_ok=True)
        src = CACHE / "aiod-cli" / art
        if src.exists():
            dest = dest_dir / name
            shutil.copy2(src, dest)
            if not name.endswith(".exe"):
                dest.chmod(0o755)
            print(f"  [Aiod] 内嵌: {plat}/{name} ({dest.stat().st_size} bytes)")
        else:
            print(f"  [WARN] 未找到缓存产物: {src}")

    print("=== 内嵌完成 ===")

if __name__ == "__main__":
    embed()
