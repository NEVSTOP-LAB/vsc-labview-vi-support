#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
save_vi_panel_image.py
======================

使用 Python 直接调用 LabVIEW VI Server / Invoke Node 等价方法，
在不显示前面板窗口的前提下导出 VI 的前面板或背面板图片。

当前实现：
1. 前面板（fp）
   - 使用 GetPanelImage。
   - 以 hidden 状态打开前面板，不显示给用户。
   - 直接获取原始像素并保存为 PNG。

2. 背面板（bd）
   - 使用 PrintVIToHTML（Complete 格式）让 LabVIEW 导出图像文件。
   - 从导出的 image 目录中提取 *d.png 作为 block diagram 图。

说明：
- 这是“Python 直接调 VI Server”的方案，不再依赖屏幕截图。
- 当前 Python 进程直接使用 COM，目标 LabVIEW 位数必须与当前 Python 位数一致。
- 对于空白或极简 block diagram，LabVIEW 的 HTML 导出可能不会生成 *d.png，此时脚本会报明确错误。
"""

from __future__ import annotations

import argparse
import glob
import os
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Optional

try:
    import pythoncom
    import win32com.client
except ImportError as exc:  # pragma: no cover
    raise SystemExit("缺少 pywin32。请先安装：pip install pywin32") from exc

try:
    from PIL import Image
except ImportError as exc:  # pragma: no cover
    raise SystemExit("缺少 Pillow。请先安装：pip install pillow") from exc

from read_vi_description import (  # type: ignore
    RequestedLabVIEWBitness,
    RequestedLabVIEWVersion,
    _ConnectionReport,
    _InstalledLabVIEW,
    _ensure_windows,
    _resolve_target_installation,
    format_connection_report,
)


_DISPATCH_METHOD = pythoncom.DISPATCH_METHOD

_DISPID_GET_PANEL_IMAGE = 1016
_DISPID_CLOSE_FRONT_PANEL = 1061
_DISPID_OPEN_FRONT_PANEL = 1080
_DISPID_PRINT_VI_TO_HTML = 1006

_FP_STATE_VISIBLE = 1
_FP_STATE_HIDDEN = 3

_PRINT_FORMAT_COMPLETE = 4
_HTML_IMAGE_FORMAT_PNG = 0


def _current_python_architecture() -> str:
    return "x64" if sys.maxsize > 2**32 else "x86"


def _normalize_panel(panel: str) -> str:
    panel_norm = panel.strip().lower()
    if panel_norm not in {"fp", "bd"}:
        raise ValueError("panel 仅支持 fp 或 bd。")
    return panel_norm


def _ensure_architecture_supported(installation: Optional[_InstalledLabVIEW]) -> None:
    if installation is None:
        return
    current_arch = _current_python_architecture()
    if installation.architecture != current_arch:
        raise RuntimeError(
            "当前纯 Python VI Server 实现要求 Python 与目标 LabVIEW 位数一致。"
            f"当前 Python: {current_arch}，目标 LabVIEW: {installation.architecture}。"
            "若必须跨位数，请改回外部宿主方案。"
        )


def _start_target_labview(installation: _InstalledLabVIEW) -> None:
    subprocess.Popen(
        [installation.exe_path, "/Automation"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _connect_labview_application(
    installation: Optional[_InstalledLabVIEW],
    report: _ConnectionReport,
    timeout_seconds: int = 45,
):
    _ensure_architecture_supported(installation)
    deadline = time.time() + timeout_seconds
    attempts = 0
    last_reason = ""

    if installation is not None:
        _start_target_labview(installation)
        time.sleep(1.0)

    while time.time() < deadline:
        attempts += 1
        try:
            pythoncom.CoInitialize()
            app = win32com.client.Dispatch("LabVIEW.Application")
            app_dir = str(app.ApplicationDirectory)
            app_ver = str(app.Version)
            report.connected_directory = app_dir
            report.connected_version = app_ver
            report.attempts = attempts
            report.host_architecture = _current_python_architecture()
            report.host_executable = sys.executable

            if installation is None:
                report.selection = "connected-default-labview-application"
                report.reason = "未显式指定版本，已连接默认 COM 实例。"
                return app

            expected = os.path.normcase(os.path.normpath(installation.install_dir))
            actual = os.path.normcase(os.path.normpath(app_dir))
            if actual == expected:
                report.selection = "matched-target-labview-application"
                report.reason = "已连接目标 LabVIEW 安装。"
                return app

            last_reason = f"已连接到 {app_dir}，但不匹配目标安装 {installation.install_dir}。"
        except Exception as exc:
            last_reason = str(exc)

        if installation is not None and attempts % 2 == 0:
            _start_target_labview(installation)
        time.sleep(0.75)

    report.selection = "failed-to-match-target-labview-application"
    report.reason = last_reason or "连接超时。"
    raise RuntimeError(report.reason)


def _invoke_open_front_panel(vi, activate: bool, state: int) -> None:
    vi._oleobj_.InvokeTypes(
        _DISPID_OPEN_FRONT_PANEL,
        0,
        _DISPATCH_METHOD,
        (pythoncom.VT_EMPTY, 0),
        ((pythoncom.VT_BOOL, 1), (pythoncom.VT_I4, 1)),
        activate,
        state,
    )


def _invoke_close_front_panel(vi) -> None:
    vi._oleobj_.InvokeTypes(
        _DISPID_CLOSE_FRONT_PANEL,
        0,
        _DISPATCH_METHOD,
        (pythoncom.VT_EMPTY, 0),
        (),
    )


def _invoke_get_panel_image(vi, visible_only: bool, depth: int):
    return vi._oleobj_.InvokeTypes(
        _DISPID_GET_PANEL_IMAGE,
        0,
        _DISPATCH_METHOD,
        (pythoncom.VT_EMPTY, 0),
        (
            (pythoncom.VT_BOOL, 1),
            (pythoncom.VT_I4, 1),
            (pythoncom.VT_BYREF | pythoncom.VT_VARIANT, 2),
            (pythoncom.VT_BYREF | pythoncom.VT_VARIANT, 2),
            (pythoncom.VT_BYREF | pythoncom.VT_VARIANT, 2),
        ),
        visible_only,
        depth,
    )


def _invoke_print_vi_to_html(vi, html_path: str, image_dir: str) -> None:
    vi._oleobj_.InvokeTypes(
        _DISPID_PRINT_VI_TO_HTML,
        0,
        _DISPATCH_METHOD,
        (pythoncom.VT_EMPTY, 0),
        (
            (pythoncom.VT_BSTR, 1),
            (pythoncom.VT_BOOL, 1),
            (pythoncom.VT_I4, 1),
            (pythoncom.VT_I4, 1),
            (pythoncom.VT_I4, 1),
            (pythoncom.VT_BSTR, 1),
        ),
        html_path,
        False,
        _PRINT_FORMAT_COMPLETE,
        _HTML_IMAGE_FORMAT_PNG,
        24,
        image_dir,
    )


def _save_front_panel_png(vi, output_path: str) -> str:
    try:
        _invoke_open_front_panel(vi, False, _FP_STATE_HIDDEN)
    except Exception:
        _invoke_open_front_panel(vi, False, _FP_STATE_VISIBLE)

    time.sleep(0.8)
    image_data, _colors, bounds = _invoke_get_panel_image(vi, True, 24)
    raw = bytes(image_data) if image_data is not None else b""

    if not raw or not bounds or len(bounds) != 4:
        raise RuntimeError("GetPanelImage 未返回有效前面板图像数据。")

    left, top, right, bottom = bounds
    width = int(right) - int(left)
    height = int(bottom) - int(top)
    if width <= 0 or height <= 0:
        raise RuntimeError(f"GetPanelImage 返回了无效边界：{bounds}")

    expected_bytes = width * height * 3
    if len(raw) != expected_bytes:
        raise RuntimeError(
            f"GetPanelImage 数据长度异常：期望 {expected_bytes} 字节，实际 {len(raw)} 字节。"
        )

    image = Image.frombytes("RGB", (width, height), raw)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    image.save(output_path)

    try:
        _invoke_close_front_panel(vi)
    except Exception:
        pass

    return output_path


def _extract_html_export_image(vi, panel: str, output_path: str) -> str:
    with tempfile.TemporaryDirectory(prefix="lv-html-export-") as temp_dir:
        html_path = os.path.join(temp_dir, "export.html")
        image_dir = os.path.join(temp_dir, "images")
        os.makedirs(image_dir, exist_ok=True)

        _invoke_print_vi_to_html(vi, html_path, image_dir)

        suffix = "p.png" if panel == "fp" else "d.png"
        candidates = sorted(glob.glob(os.path.join(image_dir, f"*{suffix}")))
        if not candidates:
            raise RuntimeError(
                "LabVIEW 的 HTML 导出未生成目标面板图像。"
                f"panel={panel}。"
                "对于空白或极简 VI，这种情况是正常的。"
            )

        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        shutil.copyfile(candidates[0], output_path)
        return output_path


def save_vi_panel_image(
    vi_path: str,
    panel: str = "fp",
    output: Optional[str] = None,
    labview_version: Optional[RequestedLabVIEWVersion] = None,
    labview_bitness: RequestedLabVIEWBitness = None,
) -> tuple[str, _ConnectionReport]:
    _ensure_windows()

    abs_vi_path = os.path.abspath(vi_path)
    if not os.path.isfile(abs_vi_path):
        raise FileNotFoundError(f"VI 文件不存在: {abs_vi_path}")

    panel_norm = _normalize_panel(panel)

    if output is None:
        stem, _ = os.path.splitext(abs_vi_path)
        suffix = ".front-panel.png" if panel_norm == "fp" else ".block-diagram.png"
        output_path = stem + suffix
    else:
        output_path = os.path.abspath(output)

    installation, report = _resolve_target_installation(
        abs_vi_path,
        preferred_version=labview_version,
        preferred_bitness=labview_bitness,
    )

    app = _connect_labview_application(installation, report)
    vi = app.GetVIReference(abs_vi_path)
    if vi is None:
        raise RuntimeError("GetVIReference 返回空对象。")

    if panel_norm == "fp":
        try:
            saved = _save_front_panel_png(vi, output_path)
        except Exception:
            saved = _extract_html_export_image(vi, panel_norm, output_path)
    else:
        saved = _extract_html_export_image(vi, panel_norm, output_path)

    return saved, report


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="save_vi_panel_image.py",
        description="使用 Python 直接调用 LabVIEW VI Server 导出前面板/背面板图片。",
    )
    parser.add_argument("vi_path", help="VI 文件路径")
    parser.add_argument("--panel", choices=["fp", "bd"], default="fp", help="fp=前面板, bd=背面板")
    parser.add_argument("--output", "-o", help="输出图片路径（默认 png）")
    parser.add_argument("--labview-version", help="显式指定目标 LabVIEW 版本，例如 2017、17.0")
    parser.add_argument("--labview-bitness", help="显式指定目标位数，例如 x86、x64")
    parser.add_argument("--verbose", action="store_true", help="输出连接诊断到 stderr")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    report: Optional[_ConnectionReport] = None

    def _print_report() -> None:
        if args.verbose and report is not None:
            for line in format_connection_report(report):
                print(f"[LabVIEW] {line}", file=sys.stderr)

    try:
        saved, report = save_vi_panel_image(
            vi_path=args.vi_path,
            panel=args.panel,
            output=args.output,
            labview_version=args.labview_version,
            labview_bitness=args.labview_bitness,
        )
        _print_report()
        print(saved)
        return 0
    except ValueError as exc:
        _print_report()
        print(f"[错误] {exc}", file=sys.stderr)
        return 4
    except FileNotFoundError as exc:
        _print_report()
        print(f"[错误] {exc}", file=sys.stderr)
        return 2
    except RuntimeError as exc:
        _print_report()
        print(f"[错误] {exc}", file=sys.stderr)
        return 3
    except Exception as exc:  # pragma: no cover
        print(f"[未预期错误] {exc}", file=sys.stderr)
        return 4


if __name__ == "__main__":
    sys.exit(main())
