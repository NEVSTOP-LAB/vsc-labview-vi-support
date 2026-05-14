#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
write_vi_props.py
=================

通过 LabVIEW ActiveX/COM 将一组属性写回 VI 文件，并调用 SaveInstrument 落盘。

与 read_vi_props.py 共享版本识别 / 安装定位 / 位数匹配 / Base64 工具，
实际写入由 write_vi_props_worker.vbs 完成（与读 worker 对称）。

仅支持 Windows 平台。

⚠️  实现说明
-----------
本脚本基于 read_vi_props.py / read_vi_props_worker.vbs 的访问模式编写，
属于 "best-effort" 实现，需要在真实 LabVIEW 环境中验证：
- 单个属性写入失败会被独立报告（同 read 行为），不会阻塞其他属性。
- 写入完成后，默认调用 ``vi.SaveInstrument`` 将更改写入磁盘。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
from typing import Optional

# 复用 read_vi_props 中已实现的版本识别与 worker 调度基础设施。
from read_vi_props import (  # type: ignore
    RequestedLabVIEWBitness,
    RequestedLabVIEWVersion,
    _ConnectionReport,
    _DEFAULT_WORKER_TIMEOUT_SECONDS,
    _InstalledLabVIEW,
    _PROP_META,
    _decode_worker_field,
    _ensure_windows,
    _resolve_target_installation,
    _select_script_host,
    format_connection_report,
)

_WRITE_WORKER_SCRIPT = os.path.join(
    os.path.dirname(__file__), "write_vi_props_worker.vbs"
)

# 与 worker 中 writableMeta 同步：可写属性名 -> ("type", "category")
# category: "vi" 表示 vi.<Name>
_WRITABLE_PROPS: dict[str, tuple[str, str]] = {
    "Description":       ("String",  "vi"),
    "HistoryText":       ("String",  "vi"),
    "AllowDebugging":    ("Boolean", "vi"),
    "ShowFPOnCall":      ("Boolean", "vi"),
    "CloseFPAfterCall":  ("Boolean", "vi"),
    "IsReentrant":       ("Boolean", "vi"),
    "RunOnOpen":         ("Boolean", "vi"),
    "PreferredExecSystem": ("Number",  "vi"),
    "ExecPriority":      ("Number",  "vi"),
}


# ---------------------------------------------------------------------------
# 请求文件构建
# ---------------------------------------------------------------------------
def _normalize_string(value) -> str:
    if value is None:
        return ""
    return str(value)


def _normalize_boolean(value) -> str:
    """Boolean 写入统一序列化为 '1' / '0'。worker 中再 CoerceBool。"""
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return "1" if value else "0"
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "-1"}:
        return "1"
    if text in {"0", "false", "no", ""}:
        return "0"
    raise ValueError(f"Invalid boolean: {value!r}")


def _normalize_number(value) -> str:
    if isinstance(value, bool):
        # bool 是 int 子类，单独处理避免 True->"1" 被误用为 number
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(int(value))
    text = str(value).strip()
    # 允许形如 "1 (预分配副本)" 这种注释格式 —— 取首段数字
    head = text.split()[0] if text else ""
    if head.lstrip("-").isdigit():
        return head
    raise ValueError(f"Invalid number: {value!r}")


def _normalize_value(prop_name: str, raw_value) -> str:
    if prop_name not in _WRITABLE_PROPS:
        raise ValueError(f"Property is not writable or unknown: {prop_name}")
    prop_type, _category = _WRITABLE_PROPS[prop_name]
    if prop_type == "String":
        return _normalize_string(raw_value)
    if prop_type == "Boolean":
        return _normalize_boolean(raw_value)
    if prop_type == "Number":
        return _normalize_number(raw_value)
    raise ValueError(f"Unsupported type for {prop_name}: {prop_type}")


def _build_request_lines(updates: dict) -> list[str]:
    """
    将 {prop_name: value} 转换为 request 文件的行序列。
    ``value`` 既可以是原生 Python 标量，也可以是 ``{"type": "...", "value": ...}``。
    """
    lines: list[str] = []
    for prop_name, raw in updates.items():
        if prop_name not in _WRITABLE_PROPS:
            raise ValueError(f"Property is not writable or unknown: {prop_name}")
        prop_type, _ = _WRITABLE_PROPS[prop_name]

        if isinstance(raw, dict) and "value" in raw:
            value = raw["value"]
        else:
            value = raw

        normalized = _normalize_value(prop_name, value)
        encoded = base64.b64encode(normalized.encode("utf-8")).decode("ascii")

        lines.append(f"set_{prop_name}_type={prop_type}")
        lines.append(f"set_{prop_name}_val={encoded}")
    return lines


def _write_request_file(updates: dict) -> str:
    handle = tempfile.NamedTemporaryFile(
        prefix="labview-vi-write-req-", suffix=".in",
        mode="w", encoding="ascii", delete=False, newline="",
    )
    try:
        for line in _build_request_lines(updates):
            handle.write(line + "\r\n")
        handle.flush()
        return handle.name
    finally:
        handle.close()


# ---------------------------------------------------------------------------
# 响应文件解析（与 read worker 兼容，并附加 saved/save_errmsg 字段）
# ---------------------------------------------------------------------------
def _parse_write_response(response_path: str, stderr: str) -> dict:
    if not os.path.isfile(response_path):
        raise RuntimeError(stderr.strip() or "COM worker 未生成响应文件。")

    raw: dict[str, str] = {}
    with open(response_path, "r", encoding="ascii", errors="strict") as f:
        for line in f:
            line = line.rstrip("\r\n")
            if not line or "=" not in line:
                continue
            k, v = line.split("=", 1)
            raw[k] = v

    result: dict = {
        "ok":                  raw.get("ok") == "1",
        "selection":           raw.get("selection", ""),
        "reason":              _decode_worker_field(raw.get("reason_b64", "")),
        "connected_version":   _decode_worker_field(raw.get("connected_version_b64", "")),
        "connected_directory": _decode_worker_field(raw.get("connected_directory_b64", "")),
        "attempts":            int(raw.get("attempts", "0") or "0"),
        "saved":               raw.get("saved") == "1",
        "save_error":          _decode_worker_field(raw.get("save_errmsg_b64", "")),
        "props":               {},
    }

    for key, value in raw.items():
        if not key.startswith("prop_"):
            continue
        rest = key[5:]
        last = rest.rfind("_")
        if last < 0:
            continue
        prop_name = rest[:last]
        suffix    = rest[last + 1:]

        entry = result["props"].setdefault(prop_name, {
            "ok": False, "type": "String", "value": None, "error": None,
        })
        if suffix == "type":
            entry["type"] = value
        elif suffix == "ok":
            entry["ok"] = value == "1"
        elif suffix == "val":
            entry["value"] = _decode_worker_field(value)
        elif suffix == "errmsg":
            entry["error"] = _decode_worker_field(value)

    for prop_name, entry in result["props"].items():
        meta = _PROP_META.get(prop_name)
        entry["writable"]    = meta[1] if meta else None
        entry["description"] = meta[2] if meta else ""

    return result


# ---------------------------------------------------------------------------
# Worker 调用
# ---------------------------------------------------------------------------
def _run_write_worker(
    installation: Optional[_InstalledLabVIEW],
    report: _ConnectionReport,
    abs_vi_path: str,
    request_path: str,
    save: bool,
) -> dict:
    host_architecture = (
        installation.architecture if installation is not None
        else ("x64" if sys.maxsize > 2**32 else "x86")
    )
    host_executable = _select_script_host(host_architecture)
    report.host_architecture = host_architecture
    report.host_executable   = host_executable

    if not os.path.isfile(_WRITE_WORKER_SCRIPT):
        raise RuntimeError(f"缺少 COM worker 脚本: {_WRITE_WORKER_SCRIPT}")

    resp_handle = tempfile.NamedTemporaryFile(
        prefix="labview-vi-write-resp-", suffix=".out", delete=False
    )
    response_path = resp_handle.name
    resp_handle.close()

    command = [
        host_executable, "//Nologo", _WRITE_WORKER_SCRIPT,
        f"/viPath:{abs_vi_path}",
        f"/requestPath:{request_path}",
        f"/responsePath:{response_path}",
        f"/timeoutSeconds:{_DEFAULT_WORKER_TIMEOUT_SECONDS}",
        f"/save:{'1' if save else '0'}",
    ]
    if installation is not None:
        command.extend([
            f"/targetExe:{installation.exe_path}",
            f"/expectedDirectory:{installation.install_dir}",
            f"/expectedVersion:{installation.major}.{installation.minor}",
        ])

    try:
        completed = subprocess.run(
            command, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
            timeout=_DEFAULT_WORKER_TIMEOUT_SECONDS + 30,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"COM worker 超时，{host_architecture} 宿主未在规定时间内完成。"
        ) from exc

    try:
        result = _parse_write_response(response_path, completed.stderr)
    finally:
        try:
            os.remove(response_path)
        except OSError:
            pass

    report.selection           = result.get("selection") or report.selection
    report.reason              = result.get("reason")    or report.reason
    report.connected_version   = result.get("connected_version") or report.connected_version
    report.connected_directory = result.get("connected_directory") or report.connected_directory
    attempts = result.get("attempts")
    if isinstance(attempts, int):
        report.attempts = attempts

    if completed.returncode != 0 or not result.get("ok", False):
        raise RuntimeError(
            str(result.get("reason") or completed.stderr.strip() or "COM worker 执行失败。")
        )

    return result


# ---------------------------------------------------------------------------
# 公开 API
# ---------------------------------------------------------------------------
def write_vi_props(
    vi_path: str,
    updates: dict,
    labview_version: Optional[RequestedLabVIEWVersion] = None,
    labview_bitness: RequestedLabVIEWBitness = None,
    save: bool = True,
) -> dict:
    """
    将一组属性写回 LabVIEW VI，并（可选）调用 SaveInstrument 落盘。

    参数
    ----
    vi_path         : VI 文件路径。
    updates         : ``{prop_name: value}``。``value`` 可为原生标量，
                      或形如 ``{"value": ..., "type": "String"}`` 的字典
                      （type 字段仅作显示，不影响转换）。
    labview_version : 显式指定目标 LabVIEW 版本（省略时从 VI 头自动识别）。
    labview_bitness : 显式指定位数。
    save            : 写入完成后是否调用 SaveInstrument（默认 True）。

    返回值
    ------
    dict — 与 ``read_vi_props`` 相似的结构，附加 ``saved`` / ``save_error`` 字段。
    """
    _ensure_windows()
    abs_vi_path = os.path.abspath(vi_path)
    if not os.path.isfile(abs_vi_path):
        raise FileNotFoundError(f"VI 文件不存在: {abs_vi_path}")

    if not isinstance(updates, dict) or not updates:
        raise ValueError("updates 不能为空字典。")

    unknown = set(updates) - set(_WRITABLE_PROPS)
    if unknown:
        raise ValueError(f"以下属性不可写或未知: {', '.join(sorted(unknown))}")

    request_path = _write_request_file(updates)
    try:
        installation, report = _resolve_target_installation(
            abs_vi_path, labview_version, labview_bitness
        )
        result = _run_write_worker(
            installation, report, abs_vi_path, request_path, save
        )
    finally:
        try:
            os.remove(request_path)
        except OSError:
            pass

    return result


# ---------------------------------------------------------------------------
# 命令行入口
# ---------------------------------------------------------------------------
def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="write_vi_props.py",
        description="将一组属性写回 LabVIEW VI 文件并保存（通过 ActiveX/COM）。",
    )
    parser.add_argument("vi_path", help="VI 文件路径")
    parser.add_argument(
        "--updates",
        help='JSON 字典字符串，如 \'{"Description":"new desc"}\'',
    )
    parser.add_argument(
        "--updates-file",
        help="包含 JSON 字典的文件路径（与 --updates 二选一）",
    )
    parser.add_argument("--labview-version",
                        help="显式指定目标 LabVIEW 版本，例如 2017、17.0")
    parser.add_argument("--labview-bitness",
                        help="显式指定目标位数，例如 x86、x64")
    parser.add_argument("--no-save", action="store_true",
                        help="只写属性，不调用 SaveInstrument")
    parser.add_argument("--verbose", action="store_true",
                        help="将版本选择与命中诊断输出到 stderr")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if not args.updates and not args.updates_file:
        print("[错误] 必须提供 --updates 或 --updates-file。", file=sys.stderr)
        return 4
    if args.updates and args.updates_file:
        print("[错误] --updates 与 --updates-file 不可同时使用。", file=sys.stderr)
        return 4

    try:
        if args.updates_file:
            with open(args.updates_file, "r", encoding="utf-8") as f:
                updates = json.load(f)
        else:
            updates = json.loads(args.updates)
    except (OSError, ValueError) as exc:
        print(f"[错误] 解析 updates 失败: {exc}", file=sys.stderr)
        return 4

    if not isinstance(updates, dict):
        print("[错误] updates 必须是 JSON 对象（字典）。", file=sys.stderr)
        return 4

    report: Optional[_ConnectionReport] = None

    def _print_report() -> None:
        if args.verbose and report is not None:
            for line in format_connection_report(report):
                print(f"[LabVIEW] {line}", file=sys.stderr)

    try:
        _ensure_windows()
        abs_vi_path = os.path.abspath(args.vi_path)
        if not os.path.isfile(abs_vi_path):
            raise FileNotFoundError(f"VI 文件不存在: {abs_vi_path}")

        unknown = set(updates) - set(_WRITABLE_PROPS)
        if unknown:
            raise ValueError(f"以下属性不可写或未知: {', '.join(sorted(unknown))}")

        request_path = _write_request_file(updates)
        try:
            installation, report = _resolve_target_installation(
                abs_vi_path, args.labview_version, args.labview_bitness
            )
            result = _run_write_worker(
                installation, report, abs_vi_path, request_path,
                save=not args.no_save,
            )
        finally:
            try:
                os.remove(request_path)
            except OSError:
                pass

        _print_report()
        print(json.dumps({
            "vi_path":     abs_vi_path,
            "lv_version":  report.connected_version if report else None,
            "saved":       result.get("saved", False),
            "save_error":  result.get("save_error", ""),
            "props":       result.get("props", {}),
        }, ensure_ascii=False, indent=2))
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
