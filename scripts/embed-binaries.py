#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scripts/embed-binaries.py —— 将全架构二进制矩阵内嵌进 main 分支的插件目录
确保用户通过主分支（main）添加市场源或安装插件时，
插件包内自带对应系统与架构的原生可执行文件，实现全平台自适应开箱即用。
"""

import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "upstream"

# 6 大标准架构平台与上游 target 映射
PLATFORMS = {
    "macos-arm64": {
        "target": "aarch64-macos",
        "ext": "",
        "aliases": ["darwin-arm64"]
    },
    "macos-amd64": {
        "target": "x86_64-macos",
        "ext": "",
        "aliases": ["darwin-x64"]
    },
    "windows-amd64": {
        "target": "x86_64-windows-gnu",
        "ext": ".exe",
        "aliases": ["win32-x64"]
    },
    "windows-arm64": {
        "target": "aarch64-windows-gnu",
        "ext": ".exe",
        "aliases": ["win32-arm64"]
    },
    "linux-amd64": {
        "target": "x86_64-linux-musl",
        "ext": "",
        "aliases": ["linux-x64"]
    },
    "linux-arm64": {
        "target": "aarch64-linux-musl",
        "ext": "",
        "aliases": []
    }
}

def embed():
    print("=== 内嵌全架构二进制矩阵到 plugins/ 目录 ===")
    
    plugins = {
        "cube-cli": "cube-cli",
        "aiod-cli": "aiod-cli"
    }
    
    for pid, bin_base in plugins.items():
        bin_root = ROOT / "plugins" / pid / "bin"
        bin_root.mkdir(parents=True, exist_ok=True)
        
        for plat_name, pinfo in PLATFORMS.items():
            target = pinfo["target"]
            ext = pinfo["ext"]
            exe_name = f"{bin_base}{ext}"
            artifact_name = f"{bin_base}-{target}{ext}"
            
            src = CACHE / pid / artifact_name
            if not src.exists():
                print(f"  [WARN] 未找到产物: {src}")
                continue
                
            # 1. 写入标准命名目录 (如 bin/macos-arm64/cube-cli)
            std_dir = bin_root / plat_name
            std_dir.mkdir(parents=True, exist_ok=True)
            std_dest = std_dir / exe_name
            shutil.copy2(src, std_dest)
            if not ext:
                std_dest.chmod(0o755)
            print(f"  [{pid}] 内嵌标准架构: {plat_name}/{exe_name} ({std_dest.stat().st_size} bytes)")
            
            # 2. 写入兼容别名目录 (如 bin/darwin-arm64/cube-cli)
            for alias in pinfo["aliases"]:
                alias_dir = bin_root / alias
                alias_dir.mkdir(parents=True, exist_ok=True)
                alias_dest = alias_dir / exe_name
                shutil.copy2(src, alias_dest)
                if not ext:
                    alias_dest.chmod(0o755)
                print(f"  [{pid}] 内嵌兼容别名: {alias}/{exe_name}")

    print("=== 内嵌完成 ===")

if __name__ == "__main__":
    embed()

