#!/usr/bin/env bash
# ============================================================
#  ClineFreePool 本地服务启动器（Linux / macOS）
#
#  用法：
#    ./start.sh          或      bash start.sh
#
#  实际逻辑在 start.mjs（与 Windows 版共用），本文件只负责
#  找到 Node 并把控制权交给它。
#
#  ⚠️ 本文件必须保存为 LF 行尾：CRLF 会让 bash 把 \r 当成命令的
#     一部分，报 "command not found" 或 "$'\r': command not found"。
#     详见 .gitattributes 中对应规则。
# ============================================================
set -u

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "================================================================"
  echo "  ClineFreePool 本地服务启动器"
  echo "================================================================"
  echo
  echo "[错误] 没有找到 Node.js。"
  echo
  echo "       请先安装后再运行本脚本：https://nodejs.org/"
  echo "       建议版本 22 LTS 或更高。"
  echo
  echo "       macOS  : brew install node"
  echo "       Ubuntu : sudo apt install nodejs npm"
  echo
  exit 1
fi

exec node "./start.mjs"
