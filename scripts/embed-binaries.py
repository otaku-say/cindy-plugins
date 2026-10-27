#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scripts/embed-binaries.py —— 把上游发布资产内嵌进 main 分支的 plugins/<id>/bin/<os>-<arch>/

数据来源只有一个：scripts/manifest.json
  upstream.artifact_template  上游发布资产名（支持 {os} {arch} {ext} {target}）
  upstream.binary_name        内嵌后的可执行文件名（支持 {ext}）
  platforms                   标准平台矩阵（os / arch / ext）
不再维护任何硬编码的平台表或插件表。

可选参数：
  --bump   有插件的二进制内容发生变化时，把该插件的 patch 版本号 +1
           （scripts/manifest.json 与 plugins/<id>/ghost.json 同步改，
           这样 marketplace 能识别出「有新版本」，本地 Cindy 才会提示更新）
  --check  只报告会改动什么，不写文件、不递增版本（CI/本地排查用）

退出码：0 = 成功（无论有没有变化）；1 = 明显错误（清单缺失、平台不对）。
"""

import argparse
import hashlib
import json
import os
import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "scripts" / "manifest.json"
CACHE = ROOT / ".cache" / "upstream"


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def bump_patch(version):
    """0.2.0 → 0.2.1；非标准版本号原样不动，避免造出畸形版本。"""
    parts = str(version).split(".")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        return version
    return f"{parts[0]}.{parts[1]}.{int(parts[2]) + 1}"


def embed(manifest, apply=True):
    """把缓存里的上游资产拷进 plugins/；返回 {plugin_id: 是否有二进制变化}。"""
    platforms = manifest["platforms"]
    changed = {}

    for pid, pmeta in manifest["plugins"].items():
        up = pmeta.get("upstream")
        if not up:
            continue  # 纯 JS 插件没有二进制

        bin_root = ROOT / "plugins" / pid / "bin"
        bin_root.mkdir(parents=True, exist_ok=True)

        # 清掉非标准平台目录（历史别名）
        for child in list(bin_root.iterdir()):
            if child.is_dir() and child.name not in platforms:
                print(f"  [{pid}] 移除非标准平台目录: {child.name}")
                if apply:
                    shutil.rmtree(child)

        did_change = False
        wanted = up.get("supported_platforms") or list(platforms)
        for plat in wanted:
            pinfo = platforms.get(plat)
            if not pinfo:
                print(f"  [{pid}] 清单里没有平台 {plat}，跳过", file=sys.stderr)
                continue

            artifact = up["artifact_template"].format(
                os=pinfo["os"], arch=pinfo["arch"], ext=pinfo["ext"], target=pinfo["target"]
            )
            src = CACHE / pid / artifact
            if not src.exists():
                print(f"  [{pid}] 缓存里没有 {artifact}（先跑 build-market.py --fetch），跳过")
                continue

            dest = bin_root / plat / up["binary_name"].format(ext=pinfo["ext"])
            same = dest.exists() and sha256(dest) == sha256(src)
            if not same:
                did_change = True
                print(f"  [{pid}] {'更新' if dest.exists() else '新增'} {plat}/{dest.name} ({src.stat().st_size} bytes)")
                if apply:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dest)
                    if not pinfo["ext"]:
                        dest.chmod(0o755)
            elif apply and not pinfo["ext"]:
                dest.chmod(0o755)

        changed[pid] = did_change
        if not did_change:
            print(f"  [{pid}] 二进制无变化")

    return changed


def write_versions(manifest, pids):
    """把 manifest 里这些插件的 patch 版本 +1，并同步写回 ghost.json。"""
    for pid in pids:
        old = manifest["plugins"][pid]["version"]
        new = bump_patch(old)
        if new == old:
            print(f"  [{pid}] 版本号 {old} 不是 x.y.z 形式，跳过递增", file=sys.stderr)
            continue
        manifest["plugins"][pid]["version"] = new
        ghost_path = ROOT / "plugins" / pid / "ghost.json"
        ghost = json.loads(ghost_path.read_text(encoding="utf-8"))
        ghost["version"] = new
        ghost_path.write_text(json.dumps(ghost, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"  [{pid}] 版本 {old} → {new}（二进制已变，供本地 Cindy 识别更新）")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bump", action="store_true", help="二进制有变化时递增 patch 版本号")
    ap.add_argument("--check", action="store_true", help="只报告，不写文件")
    args = ap.parse_args()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    print("=== 内嵌上游二进制到 plugins/<id>/bin/<os>-<arch>/ ===")
    changed = embed(manifest, apply=not args.check)

    bumped = [pid for pid, did in changed.items() if did]
    if bumped and args.bump and not args.check:
        write_versions(manifest, bumped)
        MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("=== 完成 ===")
    print("  二进制有变化: " + (", ".join(bumped) if bumped else "无"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
