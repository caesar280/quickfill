# -*- coding: utf-8 -*-
"""build_v3.py — 从 profile.json 生成 quickfill.user.js
用法: python build_v3.py
资料更新流程: 改 profile.json → 重跑本脚本 → Tampermonkey 里重装/覆盖脚本。
"""
import json, io, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROFILE = os.environ.get("QUICKFILL_PROFILE") or os.path.join(HERE, "profile.json")
TPL = os.path.join(HERE, "quickfill.template.js")
OUT = os.environ.get("QUICKFILL_OUT") or os.path.join(HERE, "quickfill.user.js")

with io.open(PROFILE, encoding="utf-8") as f:
    profile = json.load(f)

with io.open(TPL, encoding="utf-8") as f:
    tpl = f.read()

# 深拷贝到脚本里（剥掉过长的私有字段无必要——_ 开头字段脚本会跳过，保留完整信息）
data = json.dumps(profile, ensure_ascii=False, indent=1)
if "__PROFILE_JSON__" not in tpl:
    sys.exit("模板里找不到 __PROFILE_JSON__ 占位符")

out = tpl.replace("__PROFILE_JSON__", data)
with io.open(OUT, "w", encoding="utf-8") as f:
    f.write(out)

print("OK ->", OUT, f"({os.path.getsize(OUT)} bytes, profile v{profile.get('_meta',{}).get('版本','?')})")

# 语法验证：用 node --check
rc = os.system(f'node --check "{OUT}"')
