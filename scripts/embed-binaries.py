#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scripts/embed-binaries.py —— 将 6 大标准架构二进制矩阵内嵌进 main 分支的插件目录
严格遵循操作系统全称 (macos, windows, linux) 与芯片架构标准全称 (arm64, amd64) 规范，
确保通过 main 分支安装或更新插件时，插件体内天然自带标准二进制，开箱即用。
"""

import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "upstream"

# 6 大标准架构平台与上游 target 映射规范
STANDARD_PLATFORMS = {
    "macos-arm64": {
        "target": "aarch64-macos",
        "ext": ""
    },
    "macos-amd64": {
        "target": "x86_64-macos",
        "ext": ""
    },
    "windows-amd64": {
        "target": "x86_64-windows-gnu",
        "ext": ".exe"
    },
    "windows-arm64": {
        "target": "aarch64-windows-gnu",
        "ext": ".exe"
    },
    "linux-amd64": {
        "target": "x86_64-linux-musl",
        "ext": ""
    },
    "linux-arm64": {
        "target": "aarch64-linux-musl",
        "ext": ""
    }
}

def embed():
    print("=== 内嵌 6 大标准架构二进制矩阵到 plugins/ 目录 ===")
    
    plugins = {
        "cube-cli": "cube-cli",
        "aiod-cli": "aiod-cli"
    }
    
    for pid, bin_base in plugins.items():
        bin_root = ROOT / "plugins" / pid / "bin"
        bin_root.mkdir(parents=True, exist_ok=True)
        
        # 1. 物理清除所有历史非标准别名目录 (如 darwin-*, win32-*, linux-x64)
        for child in list(bin_root.iterdir()):
            if child.is_dir() and child.name not in STANDARD_PLATFORMS:
                print(f"  [{pid}] 清除非标准遗留目录: {child.name}")
                shutil.rmtree(child)
        
        # 2. 内嵌标准架构二进制
        for plat_name, pinfo in STANDARD_PLATFORMS.items():
            target = pinfo["target"]
            ext = pinfo["ext"]
            exe_name = f"{bin_base}{ext}"
            artifact_name = f"{bin_base}-{target}{ext}"
            
            src = CACHE / pid / artifact_name
            if not src.exists():
                print(f"  [{pid}] 未找到缓存产物: {src.name} (跳过)")
                continue
                
            std_dir = bin_root / plat_name
            std_dir.mkdir(parents=True, exist_ok=True)
            std_dest = std_dir / exe_name
            shutil.copy2(src, std_dest)
            if not ext:
                std_dest.chmod(0o755)
            print(f"  [{pid}] 内嵌标准架构: {plat_name}/{exe_name} ({std_dest.stat().st_size} bytes)")

    print("=== 内嵌完成 ===")

if __name__ == "__main__":
    embed()


