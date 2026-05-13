#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
read_vi_icon.py
===============

从 LabVIEW VI 文件中提取图标并保存为 PNG。

**不依赖 LabVIEW 安装**，直接解析 VI 文件的 RSRC 二进制格式。
支持 icl8（256 色）和 ICON（单色）两种图标资源。
VI 图标固定规格：32×32 像素。

用法
----
::

    # 提取图标，保存到同目录（默认命名为 <vi名>.icon.png）
    python scripts/read_vi_icon.py "C:\\path\\to\\test.vi"

    # 指定输出路径
    python scripts/read_vi_icon.py "C:\\path\\to\\test.vi" --output icon.png

    # 放大 4 倍输出（128×128），便于查看
    python scripts/read_vi_icon.py "C:\\path\\to\\test.vi" --scale 4

    # 强制使用单色 ICON 资源（默认优先 icl8）
    python scripts/read_vi_icon.py "C:\\path\\to\\test.vi" --type mono

    # 批量处理目录中所有 VI
    python scripts/read_vi_icon.py "C:\\project\\src" --recursive --output-dir icons/

    # JSON 报告
    python scripts/read_vi_icon.py "C:\\path\\to\\test.vi" --json
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import zlib
from typing import Optional

# ---------------------------------------------------------------------------
# 支持的扩展名
# ---------------------------------------------------------------------------
_VI_EXTENSIONS = {".vi", ".ctl", ".vit", ".ctt", ".vim", ".lvlib", ".lvclass"}

# ---------------------------------------------------------------------------
# Mac OS 8-bit 系统调色板（256 色），用于解码 icl8 图标
# ---------------------------------------------------------------------------
def _build_mac_8bit_palette() -> list[tuple[int, int, int]]:
    """
    生成 Mac OS 8-bit 系统调色板（256 个 RGB 三元组）。

    布局：
      • 索引   0–215 : 6×6×6 颜色立方体（从黑到白）
      • 索引 216–254 : 灰度渐变（不含纯白、纯黑）
      • 索引     255 : 白色（与索引 215 重复，确保 icl8 背景正确）
    """
    levels = (0x00, 0x33, 0x66, 0x99, 0xCC, 0xFF)
    palette: list[tuple[int, int, int]] = []
    for r in levels:
        for g in levels:
            for b in levels:
                palette.append((r, g, b))
    for i in range(39):
        v = round(i * 255 / 38)
        palette.append((v, v, v))
    palette.append((255, 255, 255))
    return palette


_MAC_8BIT_PALETTE: list[tuple[int, int, int]] = _build_mac_8bit_palette()

# ---------------------------------------------------------------------------
# RSRC 解析
# ---------------------------------------------------------------------------
def _parse_rsrc(vi_path: str) -> dict[str, bytes]:
    """
    解析 LabVIEW VI RSRC 文件，返回 {type_tag: data_bytes} 字典。

    LabVIEW RSRC 文件头布局（32 字节）：
      [0:4]   = b"RSRC"
      [4:8]   = 版本/标志
      [8:12]  = 主类型（如 b"LVIN"）
      [12:16] = 次类型（如 b"LBVW"）
      [16:20] = 资源映射偏移（uint32_be，从文件头计算）
      [20:24] = 资源映射大小（uint32_be）
      [24:28] = 资源数据偏移（uint32_be）
      [28:32] = 资源数据大小（uint32_be）

    资源映射中，类型列表偏移存储在 rmap[44:48]，
    类型条目每项 12 字节：type_tag(4) + reserved(4) + ref_list_offset(4)。
    引用条目每项 20 字节，数据偏移在 ref_entry[12:16]。
    """
    with open(vi_path, "rb") as f:
        raw = f.read()
    if raw[:4] != b"RSRC":
        raise ValueError(f"不是有效的 LabVIEW RSRC 文件（缺少 RSRC 魔数）：{vi_path}")

    map_off, _map_size, data_off, _data_size = struct.unpack_from(">IIII", raw, 16)
    rmap = raw[map_off:]

    tl_off = struct.unpack_from(">I", rmap, 44)[0]
    if tl_off + 4 > len(rmap):
        raise ValueError("RSRC 资源映射结构损坏")
    n_types = struct.unpack_from(">I", rmap, tl_off)[0] + 1

    result: dict[str, bytes] = {}
    for i in range(n_types):
        entry_base = tl_off + 4 + i * 12
        if entry_base + 12 > len(rmap):
            break
        tag = rmap[entry_base : entry_base + 4].decode("latin-1")
        rl_off = struct.unpack_from(">I", rmap, entry_base + 8)[0]
        ref_base = tl_off + rl_off
        if ref_base + 16 > len(rmap):
            continue
        data_offset = struct.unpack_from(">I", rmap, ref_base + 12)[0]
        file_off = data_off + data_offset
        if file_off + 4 > len(raw):
            continue
        sz = struct.unpack_from(">I", raw, file_off)[0]
        if sz == 0 or file_off + 4 + sz > len(raw):
            continue
        result[tag] = raw[file_off + 4 : file_off + 4 + sz]
    return result


# ---------------------------------------------------------------------------
# 图标渲染
# ---------------------------------------------------------------------------
def _render_icl8(data: bytes, scale: int) -> tuple[int, int, bytes]:
    """
    将 icl8 资源（1024 字节 8-bit 索引色）渲染为 RGBA 像素流。
    返回 (width, height, rgba_bytes)。
    """
    if len(data) < 1024:
        raise ValueError(f"icl8 数据不足：{len(data)} 字节（需要 1024）")
    w = h = 32 * scale
    rgba = bytearray(w * h * 4)
    pal = _MAC_8BIT_PALETTE
    for py in range(32):
        for px in range(32):
            idx = data[py * 32 + px]
            r, g, b = pal[idx]
            for dy in range(scale):
                for dx in range(scale):
                    off = ((py * scale + dy) * w + px * scale + dx) * 4
                    rgba[off]     = r
                    rgba[off + 1] = g
                    rgba[off + 2] = b
                    rgba[off + 3] = 255
    return w, h, bytes(rgba)


def _render_icon_mono(data: bytes, scale: int) -> tuple[int, int, bytes]:
    """
    将 ICON 资源（128 字节单色位图）渲染为 RGBA 像素流。
    bit=1 → 黑色，bit=0 → 白色。
    """
    if len(data) < 128:
        raise ValueError(f"ICON 数据不足：{len(data)} 字节（需要 128）")
    w = h = 32 * scale
    rgba = bytearray(w * h * 4)
    for row in range(32):
        row_val = struct.unpack_from(">I", data, row * 4)[0]
        for col in range(32):
            bit = (row_val >> (31 - col)) & 1
            pixel = (0, 0, 0, 255) if bit else (255, 255, 255, 255)
            r, g, b, a = pixel
            for dy in range(scale):
                for dx in range(scale):
                    off = ((row * scale + dy) * w + col * scale + dx) * 4
                    rgba[off]     = r
                    rgba[off + 1] = g
                    rgba[off + 2] = b
                    rgba[off + 3] = a
    return w, h, bytes(rgba)


# ---------------------------------------------------------------------------
# 最小 PNG 编码器（仅使用 zlib + struct，无第三方依赖）
# ---------------------------------------------------------------------------
def _write_png(path: str, width: int, height: int, rgba_data: bytes) -> None:
    """将 RGBA 像素流写入 PNG 文件（仅用标准库）。"""
    def _chunk(code: bytes, data: bytes) -> bytes:
        c = code + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    # IHDR: width(4) + height(4) + bit_depth(1=8) + color_type(1=6=RGBA)
    #       + compression(1) + filter(1) + interlace(1) = 13 bytes
    ihdr = _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))

    scanlines = bytearray()
    row_bytes = width * 4
    for y in range(height):
        scanlines.append(0)  # filter type = None
        scanlines.extend(rgba_data[y * row_bytes : (y + 1) * row_bytes])

    idat = _chunk(b"IDAT", zlib.compress(bytes(scanlines), 6))
    iend = _chunk(b"IEND", b"")

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + ihdr + idat + iend)


# ---------------------------------------------------------------------------
# 公开 API
# ---------------------------------------------------------------------------
def read_vi_icon(
    vi_path: str,
    output_path: Optional[str] = None,
    scale: int = 1,
    prefer_mono: bool = False,
) -> str:
    """
    从 LabVIEW VI 文件提取图标并保存为 PNG。

    参数
    ----
    vi_path     : VI 文件路径。
    output_path : 输出 PNG 路径；省略时在 vi_path 同目录生成 <vi名>.icon.png。
    scale       : 输出放大倍数（默认 1 = 32×32，建议 4 = 128×128）。
    prefer_mono : True 时优先使用单色 ICON 资源；默认优先 icl8（256 色）。

    返回值
    ------
    str — 实际写入的 PNG 文件路径。
    """
    abs_path = os.path.abspath(vi_path)
    if not os.path.isfile(abs_path):
        raise FileNotFoundError(f"VI 文件不存在：{abs_path}")

    resources = _parse_rsrc(abs_path)

    # 按优先级选择图标资源
    if prefer_mono:
        priority = ("ICON", "icl8")
    else:
        priority = ("icl8", "ICON")

    chosen_tag: Optional[str] = None
    for tag in priority:
        if tag in resources:
            chosen_tag = tag
            break

    if chosen_tag is None:
        available = list(resources.keys())
        raise RuntimeError(
            f"VI 文件中未找到图标资源（icl8 / ICON）。"
            f"已有资源类型：{available}"
        )

    data = resources[chosen_tag]
    if chosen_tag == "icl8":
        w, h, rgba = _render_icl8(data, scale)
    else:
        w, h, rgba = _render_icon_mono(data, scale)

    if output_path is None:
        vi_stem = os.path.splitext(os.path.basename(abs_path))[0]
        output_path = os.path.join(
            os.path.dirname(abs_path), f"{vi_stem}.icon.png"
        )

    output_path = os.path.abspath(output_path)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    _write_png(output_path, w, h, rgba)
    return output_path


# ---------------------------------------------------------------------------
# 批量处理
# ---------------------------------------------------------------------------
def _collect_vi_files(path: str, recursive: bool) -> list[str]:
    if os.path.isfile(path):
        ext = os.path.splitext(path)[1].lower()
        return [path] if ext in _VI_EXTENSIONS else []
    result: list[str] = []
    if recursive:
        for root, _dirs, files in os.walk(path):
            for fn in files:
                if os.path.splitext(fn)[1].lower() in _VI_EXTENSIONS:
                    result.append(os.path.join(root, fn))
    else:
        for fn in os.listdir(path):
            if os.path.splitext(fn)[1].lower() in _VI_EXTENSIONS:
                result.append(os.path.join(path, fn))
    return sorted(result)


# ---------------------------------------------------------------------------
# 命令行入口
# ---------------------------------------------------------------------------
def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="read_vi_icon.py",
        description="从 LabVIEW VI 文件提取图标并保存为 PNG（无需 LabVIEW 安装）。",
    )
    parser.add_argument("vi_path", nargs="+", help="VI 文件路径或目录")
    parser.add_argument("--output", "-o", help="单文件模式下的输出 PNG 路径")
    parser.add_argument(
        "--output-dir", help="批量模式下的输出目录（省略则写到 VI 同目录）"
    )
    parser.add_argument(
        "--scale", "-s", type=int, default=1, metavar="N",
        help="图标放大倍数（默认 1=32×32，建议 4=128×128）",
    )
    parser.add_argument(
        "--type", choices=["auto", "color", "mono"], default="auto",
        help="图标资源类型：auto=自动（优先 icl8），color=强制 icl8，mono=强制 ICON",
    )
    parser.add_argument("--recursive", "-r", action="store_true", help="递归扫描目录")
    parser.add_argument("--json", action="store_true", help="以 JSON 格式输出结果")
    parser.add_argument("--quiet", "-q", action="store_true", help="静默模式（仅打印错误）")
    args = parser.parse_args(argv)

    prefer_mono = args.type == "mono"

    # 收集所有目标 VI 文件
    all_files: list[str] = []
    for p in args.vi_path:
        all_files.extend(_collect_vi_files(p, args.recursive))

    if not all_files:
        print("[错误] 未找到任何 VI 文件。", file=sys.stderr)
        return 2

    results: list[dict] = []
    exit_code = 0

    for vi_path in all_files:
        # 确定输出路径
        if len(all_files) == 1 and args.output:
            out_path = args.output
        elif args.output_dir:
            stem = os.path.splitext(os.path.basename(vi_path))[0]
            out_path = os.path.join(args.output_dir, f"{stem}.icon.png")
        else:
            out_path = None  # 默认：vi 同目录

        try:
            saved = read_vi_icon(
                vi_path,
                output_path=out_path,
                scale=args.scale,
                prefer_mono=prefer_mono,
            )
            if not args.quiet and not args.json:
                print(f"[OK] {vi_path}")
                print(f"     → {saved}")
            results.append({"vi_path": vi_path, "ok": True, "output": saved})
        except Exception as exc:
            print(f"[错误] {vi_path}: {exc}", file=sys.stderr)
            results.append({"vi_path": vi_path, "ok": False, "error": str(exc)})
            exit_code = 3

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
