// ==UserScript==
// @name         quickfill · 网申秒填助手
// @namespace    lingyang.quickfill
// @version      3.1.0
// @description  网申表单秒填：吃 profile.json 单一数据源；字段别名表+全局唯一匹配；原生下拉/自定义下拉/单选/多选/级联(省市县)/日期全支持；绿橙标记。只填充，绝不自动提交。
// @author       聆阳
// @match        *://*/*
// @downloadURL  https://github.com/caesar280/quickfill/releases/latest/download/quickfill.user.js
// @updateURL    https://github.com/caesar280/quickfill/releases/latest/download/quickfill.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// @all-frames   true
// ==/UserScript==
//
// v3.0 相比 v2.1 的升级（借鉴 OpenJobAutofill / FormFilla）：
//   1. 资料来自 profile.json（build_v3.py 灌入），面板可粘贴导入新版 JSON；
//   2. 字段别名表：一个资料键对多个站点叫法（手机/电话/联系方式/mobile…）；
//   3. 全局唯一匹配：所有(字段,控件)打分后按分数贪心一一配对，不会两个字段抢同一个框；
//   4. 单选/多选：按选项文字匹配后点选（性别/婚姻/是否服从调配…）；
//   5. 级联下拉：籍贯「浙江省-杭州市-西湖区」逐级点选；
//   6. 日期控件：type=date/month 直接设值；ant/arco 日期picker尝试键入；
//   7. 填完绿/橙描边标记，橙色值自动复制到剪贴板；
//   8. 「展开编辑卡片」可先点开摘要式 ATS 的编辑按钮再填充。
// 红线：绝不自动提交；敏感字段按 manual_fields 配置跳过。

(function () {
  'use strict';

  // ======================== 资料数据（由 build_v3.py 从 profile.json 生成） ========================
  const DEFAULT_PROFILE = __PROFILE_JSON__;
  const LS_KEY = 'jlj_form_filler_profile_v3';
  const VER = '3.1.0';   // 与 @version 同步（面板标题/日志统一引用，避免"界面 v3.1 / 元数据 3.0.0"的错位）

  // P-D: 资料存 Tampermonkey 扩展域存储（GM_*），页面脚本读不到、也预置不了
  // GM 降级契约：无 TM 时不回退 localStorage，直接抛错提示用户
  const HAS_GM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

  function gmGet(key, fallback) {
    try {
      if (HAS_GM) return GM_getValue(key, fallback);
    } catch (e) { /* fallthrough */ }
    return fallback;
  }
  function gmSet(key, val) {
    try {
      if (HAS_GM) { GM_setValue(key, val); return true; }
    } catch (e) { /* fallthrough */ }
    return false;
  }
  function gmDel(key) {
    try {
      if (typeof GM_deleteValue === 'function') { GM_deleteValue(key); return true; }
    } catch (e) { /* fallthrough */ }
    return false;
  }

  function loadProfile() {
    // P-D: 只读 GM 存储，绝不回退 localStorage（防止页面预置攻击）
    if (!HAS_GM) {
      console.warn('[秒填助手] 未检测到 Tampermonkey GM 存储，使用内置资料。');
      return JSON.parse(JSON.stringify(DEFAULT_PROFILE));
    }
    const stored = gmGet(LS_KEY, null);
    if (stored) {
      try { return JSON.parse(stored); } catch (e) { /* fallthrough */ }
    }
    return JSON.parse(JSON.stringify(DEFAULT_PROFILE));
  }
  let PROFILE = loadProfile();
  const isSampleProfile = () => !!(PROFILE && PROFILE._meta && PROFILE._meta['示例数据'] === true);

  // ======================== 基础工具 ========================
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || '').replace(/[\s*＊·:：()（）\[\]【】\/、,，.。\-—_]/g, '').toLowerCase();

  function isVisible(el) {
    if (!el) return false;
    // label 元素可能没有几何尺寸，但仍然是可见的
    if (el.tagName === 'LABEL' || (el.className && String(el.className).includes('label'))) {
      const st = getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
    }
    if (!el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
  }

  // Shadow DOM 里的元素 getBoundingClientRect 可能返回 0，需特殊处理
  function isVisibleDeep(el) {
    if (!el) return false;
    // 如果元素在 Shadow DOM 里，用宿主元素的可见性代替
    let root = el.getRootNode && el.getRootNode();
    if (root && root.host) {
      return isVisible(root.host);
    }
    return isVisible(el);
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fallthrough */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove(); return true;
    } catch (e) { return false; }
  }

  // ======================== 字段别名表（资料键 → 各站点常见叫法） ========================
  const ALIASES = {
    '姓名': ['名字', 'name', '您的姓名', '候选人姓名'],
    '英文名': ['english name', '英文名称', '拼音名'],
    '性别': ['gender', 'sex'],
    '手机': ['手机号', '手机号码', '联系电话', '电话', '联系方式', 'mobile', 'phone', 'tel', 'contact number'],
    '手机_带区号': ['国际手机号', '手机号(含区号)'],
    '邮箱': ['电子邮箱', '电子邮件', 'e-mail', 'email', 'mail', 'qq邮箱', '联系邮箱'],
    '出生日期': ['生日', '出生年月日', 'birth', 'date of birth'],
    '出生年月': ['出生年月'],
    '年龄': ['age'],
    '民族': ['ethnic', '民族类别'],
    '政治面貌': ['政治身份', '政治状态', 'political'],
    '籍贯': ['祖籍', '籍贯所在地', 'native place'],
    '籍贯_三级': ['籍贯(省市区)', '籍贯省市县', '籍贯(省-市-县)'],
    '户口所在地': ['户籍', '户籍所在地', '户籍地址', '户口', '户口地址', '户口所在城市'],
    '所在地': ['现居住地', '现居城市', '居住地', '现所在地', '当前所在城市', '所在城市', '现居地', '目前所在城市'],
    '所在地_二级': ['现居住地(省市)', '所在省份城市'],
    '国家地区': ['国籍', '国家/地区', 'country', '国籍/地区'],
    '婚姻状况': ['婚姻状态', '婚否', 'marital'],
    '身份证号': ['身份证', '身份证号码', '证件号码', '证件号', 'id card', 'idcard'],
    '工作经验': ['工作年限', '工作年数', 'years of experience', '年限'],
    '最高学历': ['学历', '最高学历程度', 'education', '教育程度', '文化程度'],
    '学位': ['degree', '学位类型'],
    '最近公司': ['最近任职公司', '上一家公司', '当前公司'],
    '是否有亲属在本公司任职': ['亲属任职', '是否有亲属在本单位任职', '亲属回避'],
    '是否服从调配': ['服从分配', '服从调剂', '是否服从调剂', '是否服从分配', '是否服从工作调配'],
    '是否接受调剂到其他岗位': ['接受调剂', '是否接受调剂'],
    '到岗时间': ['入职时间', '可到岗时间', '到岗日期', '最早到岗', '可入职时间', '入职日期', '上岗时间', '预计到岗时间'],
    '线下面试安排': ['面试时间安排', '可面试时间'],
    '期望工作城市': ['期望城市', '期望工作地点', '意向城市', '期望地点', '意向工作城市', '期望工作地点'],
    '期望工作城市_二级': ['期望城市(省市)'],
    '期望职能': ['期望职位类别', '意向职能', '职能', '职位类别', '期望职能类别', '意向职能类别'],
    '期望行业': ['意向行业', '行业意向'],
    '期望职位': ['期望岗位', '意向职位', '期望岗位名称', '求职岗位', '应聘岗位', '职位'],
    '就读时间': ['在校时间', '就读起止时间'],
    '开始时间': ['起始时间', '开始日期', '起始日期', 'from', '起'],
    '结束时间': ['结束日期', '至', 'to'],
    '入学时间': ['入学日期', '入学年份'],
    '毕业时间': ['毕业日期', '毕业年份', '离校时间'],
    '学校名称': ['学校', '院校', '毕业院校', '就读院校', '大学', 'school', 'university'],
    '学院': ['院系', '所属院系', '二级学院'],
    '专业名称': ['专业', '所学专业', '就读专业', 'major'],
    '专业': ['所学专业', '就读专业', '专业名称', 'major'],
    '学历类型': ['培养方式', '教育类型', '就读方式', '全日制/非全日制'],
    '是否全日制': ['全日制', '培养方式'],
    '学校所在国家地区': ['留学国家', '学校所在国家'],
    '主修课程': ['课程', '所学课程', '主要课程', '主修'],
    '成绩排名': ['排名', '绩点排名', 'gpa排名'],
    '专业描述': ['专业简介', '专业说明'],
    '公司名称': ['公司', '单位名称', '实习单位', '实习公司', '企业名称', 'company', '单位'],
    '公司名称_简': ['公司简称'],
    '职位名称': ['职位', '职务', '岗位名称', '实习岗位', '岗位', 'position', 'title'],
    '职位性质': ['工作性质', '性质'],
    '所属行业': ['行业', '行业类别', '公司行业'],
    '工作职责': ['职责描述', '工作内容', '工作描述', '职责', '实习内容', '实习描述', '主要职责', '工作职责描述', 'job duty', '工作业绩'],
    '是否至今': ['至今'],
    '组织名称': ['社团名称', '组织', '学生组织', '社团'],
    '级别': ['组织级别', '社团级别'],
    '职务': ['校内职务', '担任职务', '担任职务', '学生职务', '校内任职职务'],
    '职责描述': ['职责', '工作内容', '描述', '主要职责', '活动描述', '组织职责'],
    '项目名称': ['项目', '项目题目', '项目名', 'project'],
    '项目全称': ['项目全名'],
    '担任角色': ['项目角色', '角色', '项目中角色', '项目职责'],
    '品牌命题': ['命题', '题目'],
    '项目概述': ['项目描述', '项目内容', '项目简介', '项目介绍', '描述', '项目说明'],
    '获奖时间': ['获奖日期', '得奖时间', '获奖年月'],
    '获奖时间_年': ['获奖年份'],
    '获奖时间_月': ['获奖月份'],
    '奖项名称': ['奖项', '奖励名称', '获奖名称', '荣誉名称', '奖项全称'],
    '奖项等级': ['获奖等级', '奖项级别', '等级'],
    '奖项级别': ['获奖级别', '级别'],
    '颁奖单位': ['颁发单位', '主办单位', '颁奖机构'],
    '团队成员': ['队伍成员', '小组成员'],
    '指导教师': ['指导老师', '导师'],
    '作品名称': ['作品', '作品题目'],
    '语言类型': ['语种', '语言', 'language'],
    '掌握程度': ['熟练程度', '语言水平', '水平', '程度'],
    '证书名称': ['资格证书', '证书', '资格证', 'certificate'],
    '语言资格类证书': ['语言证书', '外语证书'],
    '发证机构': ['颁发机构', '发证单位', '认证机构'],
    '发证日期': ['颁发日期', '获证时间', '证书时间'],
    '证书编号': ['编号'],
    '考试成绩': ['分数', '成绩', '考试分数'],
    '自我评价': ['自我描述', '个人评价', '个人描述', '自我介绍', '个人简介', 'self evaluation'],
    '曾获奖学金': ['奖学金'],
  };

  // 值提示：站点选项与资料值写法不一致时的等价说法
  const VALUE_HINTS = {
    '共青团员': ['共青团员', '团员', '中国共产主义青年团团员', '共青团'],
    '中共党员': ['中共党员', '党员', '中国共产党党员'],
    '群众': ['群众', '无党派人士', '无'],
    '应届毕业生': ['应届毕业生', '应届', '应届生', '在校学生', '在校生', '学生'],
    '未婚': ['未婚', '单身', '尚未结婚'],
    '已婚': ['已婚', '已结婚'],
    '汉族': ['汉族', '汉'],
    '男': ['男', '男性', 'male', '先生'],
    '女': ['女', '女性', 'female', '女士'],
    '本科': ['本科', '大学本科', '学士', 'bachelor', '全日制本科', '本科及以上'],
    '硕士': ['硕士', '研究生', '硕士研究生'],
    '工学学士': ['工学学士', '工学士', '学士'],
    '是': ['是', 'yes', 'true', '确定', '同意', '服从', '愿意'],
    '否': ['否', 'no', 'false', '不', '不愿意'],
    '至今': ['至今', '现在', 'present', '在职'],
    '一般': ['一般', '一般水平', '基本掌握', '日常交流'],
    '中国': ['中国', '中华人民共和国', 'china', '中国大陆'],
    '杭州': ['杭州', '浙江省杭州市', '杭州市'],
    '苏州': ['苏州', '江苏省苏州市', '苏州市'],
    '市场营销': ['市场营销', '市场', '营销', '市场类', '市场营销类'],
    '管培生': ['管培生', '管理培训生', '培训生'],
  };

  // ======================== 站点适配（选择器集合，按常见 ATS 归并） ========================
  // v3.1: 扩展支持 TDesign / DevUI / 更多现代组件库
  const FORM_ITEM_SEL = '.ant-form-item,.ant-form-item-control,.form-item,[class*="form-item"],[class*="formItem"],[class*="FormItem"],[class*="form_item"],.kuma-form-item,.uxcore-form-row,.next-form-item,.arco-form-item,.semi-form-field,.t-form-item,.devui-form-item,[class*="field-wrapper"],[class*="question-item"],[class*="form__item"],[class*="form-row"]';
  const LABEL_SEL = 'label,.ant-form-item-label,[class*="formLabel"],[class*="form-label"],dt,.kuma-label,.next-form-item-label,.arco-form-item-label,.semi-form-field-label,.t-form-item__label,.devui-form-item-label,.form-item__text,.form-item__title,[class*="label"]:not([class*="label-value"]):not([class*="label__value"])';
  const CONTROL_SEL = 'input:not([type=hidden]):not([type=password]):not([type=file]):not([type=radio]):not([type=checkbox]), textarea, select, [role="combobox"], .ant-select-selector, .el-select__wrapper, .t-select__wrap, .devui-select__wrapper, [class*="select-wrapper"]:not([class*="ant-select"]):not([class*="el-select"])';
  const OPTION_SEL = '.ant-select-item-option,.ant-select-item,.el-select-dropdown__item,.arco-select-option,.semi-select-option,.next-select-menu-item,.ant-cascader-menu-item,.arco-cascader-option,.t-select-option,.devui-select-item,[role="option"],.c-select-item,.select-option,[class*="select-option"],.phoenix-selectList__listItem,.option,li.select-item,li[itemoption],li[data-value],[class*="dropdown"] [class*="item"]:not([class*="items"])';
  const SELECT_WRAP = '.ant-select,.el-select,.arco-select,.semi-select,.next-select,.t-select,.n-select,.devui-select,.ant-cascader-picker,.arco-cascader-picker,.t-cascader,.devui-cascader,[class*="select"],[class*="Select"],[class*="cascader"],[class*="Cascader"],[role="combobox"],[class*="dropdown"],[class*="picker"]';

  // ======================== Shadow DOM 穿透工具 ========================
  function querySelectorAllDeep(selector, root) {
    const results = [];
    const walk = (node) => {
      if (!node) return;
      try {
        node.querySelectorAll(selector).forEach(el => results.push(el));
      } catch (e) { /* noop */ }
      try {
        node.querySelectorAll('*').forEach(el => {
          if (el.shadowRoot) walk(el.shadowRoot);
        });
      } catch (e) { /* noop */ }
    };
    walk(root || document);
    return results;
  }

  function querySelectorDeep(selector, root) {
    const all = querySelectorAllDeep(selector, root);
    return all[0] || null;
  }

  // 判断元素是否在面板内
  function isInPanel(el) {
    if (!el) return false;
    if (el.closest && el.closest('#jlj-panel-host')) return true;
    let p = el;
    while (p) {
      if (p.id === 'jlj-panel-host') return true;
      p = p.parentNode || (p.host || null);
    }
    return false;
  }

  // 控件 → 标签文本（v3.1: 增强语义化识别）
  function labelOf(el) {
    const parts = [];
    const push = s => { s = (s || '').replace(/\s+/g, ' ').trim(); if (s && s.length <= 40) parts.push(s); };
    // Q7 优先级1: 原生 label 关联
    if (el.labels && el.labels.length) {
      for (const l of el.labels) { if (l.innerText) push(l.innerText); }
    }
    // Q7 优先级2: aria-labelledby / aria-label
    const labelledby = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledby) {
      try {
        const labEl = document.getElementById(labelledby);
        if (labEl && labEl.innerText) push(labEl.innerText);
      } catch (e) { /* noop */ }
    }
    push(el.getAttribute && el.getAttribute('aria-label'));
    // Q7 优先级3: placeholder
    push(el.getAttribute && el.getAttribute('placeholder'));
    if (el.id) {
      try {
        const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (l) push(l.innerText);
      } catch (e) { /* noop */ }
    }
    // 适配容器内的 label 元素（最可靠）
    let containerLbl = null;
    try {
      const container = el.closest(FORM_ITEM_SEL);
      if (container) {
        const lbl = container.querySelector(LABEL_SEL);
        if (lbl && isVisible(lbl) && !lbl.contains(el)) { containerLbl = lbl.innerText; push(lbl.innerText); }
        else if (lbl && lbl.contains(el)) { containerLbl = lbl.innerText; push(lbl.innerText); }
        // phoenix 类：标签不是独立元素，容器文本本身即标签（如 div.form-item → "姓名"）
        if (!containerLbl) {
          const ctext = (container.innerText || '').replace(/\s+/g, ' ').trim();
          if (ctext && ctext.length <= 15) {
            const own2 = (el.innerText || el.value || '').trim();
            const lab2 = own2 ? ctext.split(own2).join(' ').trim() : ctext;
            if (lab2 && lab2 !== ctext) { containerLbl = lab2; push(lab2); }
          }
        }
      }
    } catch (e) { /* noop */ }
    // 兜底：向上爬（v2.1 启发式）——仅在容器标签完全缺失时启用，且文本不超过 20 字
    if (!containerLbl) {
    const own = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim();
    let p = el, hops = 0, best = '';
    while (p && hops < 6 && p.parentElement) {
      p = p.parentElement; hops++;
      let t = (p.innerText || '').replace(/\s+/g, ' ').trim();
      if (own && t.includes(own)) t = t.replace(own, ' ').replace(/\s+/g, ' ').trim();
      if (t && t.length >= 2 && t.length <= 20) best = t;
      const others = Array.from(p.querySelectorAll('input, textarea, select'))
        .filter(o => o !== el && o.type !== 'hidden');
      if (others.length && hops >= 2) break;
    }
    if (best) push(best);
    }
    return parts.join(' | ');
  }

  // ======================== 匹配打分 + 全局唯一分配 ========================
  function scoreLabel(label, key) {
    const aliases = [key].concat(ALIASES[key] || []);
    let best = -1;
    const nl = norm(label);
    if (!nl) return -1;
    for (const a of aliases) {
      const na = norm(a);
      if (!na) continue;
      let s = -1;
      if (nl === na) s = 100;
      else if (nl.startsWith(na) || nl.endsWith(na)) s = 70;
      else if (nl.includes(na)) s = 55;
      else if (na.includes(nl) && nl.length >= 2) s = 40;
      if (s > 0 && Math.abs(nl.length - na.length) > 14) s -= 15;
      if (s > best) best = s;
    }
    return best;
  }

  function matchPairs(pairs, candidates) {
    const edges = [];
    pairs.forEach((p, pi) => {
      candidates.forEach((c, ci) => {
        let s = scoreLabel(c.label, p.key);
        // 单选组特殊处理：如果 label 匹配失败，用 radio 的 name 属性做别名匹配
        if (s < 30 && c.kind === 'group' && c.group && c.group.options[0] && c.group.options[0].input) {
          const nameMap = {
            'gender': '性别', 'sex': '性别',
            'political': '政治面貌', 'political_status': '政治面貌',
            'marital': '婚姻状况', 'marriage': '婚姻状况',
            'nation': '民族', 'ethnic': '民族',
          };
          const mapped = nameMap[c.group.options[0].input.name.toLowerCase()];
          if (mapped) {
            const s2 = scoreLabel(mapped, p.key);
            if (s2 > s) s = s2;
          }
        }
        if (s >= 30) edges.push({ pi, ci, s });
      });
    });
    edges.sort((a, b) => b.s - a.s);
    const usedP = new Set(), usedC = new Set(), res = [];
    for (const e of edges) {
      if (usedP.has(e.pi) || usedC.has(e.ci)) continue;
      usedP.add(e.pi); usedC.add(e.ci);
      res.push({ pair: pairs[e.pi], cand: candidates[e.ci], score: e.s });
    }
    return res;
  }

  // ======================== 单选/多选组 ========================
  function optionLabelOf(r) {
    const l = r.closest('label');
    if (l && l.innerText && l.innerText.trim()) return l.innerText.trim();
    const p = r.parentElement;
    if (p) { const t = (p.innerText || '').trim(); if (t && t.length < 30) return t; }
    const n = r.nextElementSibling;
    if (n && n.innerText && n.innerText.trim().length < 30) return n.innerText.trim();
    return r.value || '';
  }

  function collectChoiceGroups() {
    const groups = new Map();
    // Q4: 穿透 Shadow DOM 收集单选/多选
    querySelectorAllDeep('input[type=radio], input[type=checkbox]').forEach(r => {
      if (!isVisible(r)) return;
      if (isInPanel(r)) return;
      let container = null;
      try { container = r.closest(FORM_ITEM_SEL); } catch (e) { /* noop */ }
      // 兜底：如果 FORM_ITEM_SEL 没匹配到，向上找包含 label 的父元素
      if (!container) {
        let p = r.parentElement, hops = 0;
        while (p && hops < 5) {
          if (p.querySelector && p.querySelector('label, [class*="label"]')) { container = p; break; }
          p = p.parentElement; hops++;
        }
      }
      if (!container) container = r.closest('label') ? r.closest('label').parentElement : r.parentElement;
      if (!container) return;
      const gkey = (r.type === 'radio' && r.name) ? ('n:' + r.name + '@' + containerOuterKey(container)) : ('c:' + containerOuterKey(container));
      if (!groups.has(gkey)) groups.set(gkey, { container, options: [], label: '' });
      groups.get(gkey).options.push({ input: r, label: optionLabelOf(r) });
    });
    const out = [];
    groups.forEach(g => {
      if (!g.options.length) return;
      let lab = '';
      // 优先：容器内找 LABEL_SEL
      try {
        const lbl = g.container.querySelector(LABEL_SEL);
        if (lbl && isVisible(lbl)) lab = lbl.innerText;
      } catch (e) { /* noop */ }
      // 次优：容器内找 label 元素（排除包含 radio/checkbox 的选项标签）
      if (!lab) {
        const labels = Array.from(g.container.querySelectorAll('label'));
        for (const l of labels) {
          // 跳过包含 radio/checkbox 的 label（那些是选项，不是组标签）
          if (l.querySelector('input[type="radio"], input[type="checkbox"]')) continue;
          if (isVisible(l)) { lab = l.innerText; break; }
        }
      }
      // 兜底：向上找兄弟节点中的标签（如 .ant-form-item-label 在 control 的兄弟节点里）
      if (!lab) {
        // 方案1：找父元素的兄弟节点中的 label
        let ancestor = g.container;
        for (let i = 0; i < 5 && ancestor; i++) {
          const parent = ancestor.parentElement;
          if (!parent) break;
          // 在父元素的所有子节点中找 label（排除当前容器）
          const candidates = Array.from(parent.children).filter(c => c !== ancestor);
          for (const c of candidates) {
            if (c.matches && c.matches(LABEL_SEL) && isVisible(c)) { lab = c.innerText; break; }
            const inner = c.querySelector && c.querySelector(LABEL_SEL);
            if (inner && isVisible(inner)) { lab = inner.innerText; break; }
          }
          if (lab) break;
          ancestor = parent;
        }
      }
      // 再兜底：如果 label 是选项文字（说明组标签提取失败），尝试用 name 属性做标签
      if (!lab || (lab && lab.length <= 2 && g.options.some(o => o.label === lab))) {
        // 用 radio 的 name 属性做标签（如 "gender" → 尝试匹配"性别"）
        const firstRadio = g.options[0] && g.options[0].input;
        if (firstRadio && firstRadio.name) {
          const nameMap = {
            'gender': '性别', 'sex': '性别',
            'political': '政治面貌', 'political_status': '政治面貌',
            'marital': '婚姻状况', 'marriage': '婚姻状况',
            'nation': '民族', 'ethnic': '民族',
          };
          const mapped = nameMap[firstRadio.name.toLowerCase()];
          if (mapped) lab = mapped;
        }
      }
      // 再兜底：容器 innerText 减去选项文字
      if (!lab) {
        let t = (g.container.innerText || '').replace(/\s+/g, ' ').trim();
        for (const o of g.options) t = t.split(optionLabelOf(o.input)).join(' ');
        lab = t.replace(/\s+/g, ' ').trim().slice(0, 30);
      }
      g.label = lab;
      out.push(g);
    });
    return out;
  }

  let _ck = 0;
  function containerOuterKey(el) {
    if (!el.__jljGroupKey) el.__jljGroupKey = 'g' + (++_ck);
    return el.__jljGroupKey;
  }

  function choiceMatch(optionText, value) {
    const cands = [String(value)].concat(VALUE_HINTS[String(value)] || []);
    const ot = norm(optionText);
    if (!ot) return false;
    for (const c of cands) {
      const nc = norm(c);
      if (!nc) continue;
      const strict = nc.length <= 2;
      if (ot === nc) return true;
      if (!strict && (ot.includes(nc) || (nc.includes(ot) && ot.length >= 2))) return true;
    }
    return false;
  }

  function fillChoiceGroup(group, value) {
    // 单 checkbox：布尔语义（是否…）
    if (group.options.length === 1 && group.options[0].input.type === 'checkbox') {
      const want = ['是', 'yes', 'true', '1', '同意', '服从', '愿意'].includes(String(value).trim().toLowerCase());
      const cb = group.options[0].input;
      if (cb.checked !== want) {
        cb.scrollIntoView({ block: 'center' });
        cb.click();
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }
    for (const opt of group.options) {
      if (choiceMatch(opt.label, value)) {
        opt.input.scrollIntoView({ block: 'center' });
        opt.input.click();
        opt.input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  // 按 name 属性找单选组（兜底：当 label 匹配失败时）
  function findChoiceGroupByName(name) {
    const groups = collectChoiceGroups();
    for (const g of groups) {
      if (g.options[0] && g.options[0].input && g.options[0].input.name === name) {
        return g;
      }
    }
    return null;
  }

  // ======================== 下拉/级联/日期 ========================
  function isCustomDropdown(el) {
    if (el.tagName === 'SELECT') return false;
    if (el.getAttribute && el.getAttribute('role') === 'combobox') return true;
    try { if (el.closest(SELECT_WRAP)) return true; } catch (e) { /* noop */ }
    return false;
  }

  function looksLikeCascader(el) {
    try { return !!el.closest('.ant-cascader-picker,.arco-cascader-picker,[class*="cascader"],[class*="Cascader"]'); } catch (e) { return false; }
  }

  function pickOption(value) {
    const cands = [String(value)].concat(VALUE_HINTS[String(value)] || []);
    // Q4: 穿透 Shadow DOM 查找选项
    const opts = querySelectorAllDeep(OPTION_SEL);
    for (const o of opts) {
      if (!isVisible(o)) continue;
      if (isInPanel(o)) continue;
      const t = (o.innerText || '').trim();
      const nt = norm(t);
      if (!nt) continue;
      for (const c of cands) {
        const nc = norm(c);
        if (!nc) continue;
        const strict = nc.length <= 2;
        if (nt === nc || (!strict && (nt.includes(nc) || (nc.includes(nt) && nt.length >= 2)))) {
          o.scrollIntoView({ block: 'nearest' });
          o.click();
          return t;
        }
      }
    }
    return null;
  }

  function closeDropdown() {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    try {
      const ae = document.activeElement;
      if (ae) ae.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    } catch (e) { /* noop */ }
  }

  function openTrigger(el) {
    const trigger = (el.closest && el.closest(SELECT_WRAP)) || el;
    trigger.scrollIntoView({ block: 'center' });
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, view: window }));
    trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, view: window }));
    try { trigger.click(); } catch (e) { /* noop */ }
    // 部分站点的展开监听在 input 本身而非包裹层（如级联 input），补点一次 el
    if (trigger !== el) {
      try {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, view: window }));
        el.click();
      } catch (e) { /* noop */ }
    }
    return trigger;
  }

  async function fillCustomDropdown(el, value) {
    openTrigger(el);
    await sleep(350);
    let hit = pickOption(value);
    if (!hit && el.tagName === 'INPUT' && !el.readOnly && !el.disabled) {
      setNativeValue(el, String(value));
      await sleep(400);
      hit = pickOption(value);
    }
    if (!hit) { await sleep(250); hit = pickOption(value); }
    closeDropdown();
    return !!hit;
  }

  // 级联值变体查找：pair 的值没有分隔符时，找 profile 里的 _三级/_二级 版本
  function lookupVariantValue(key) {
    const sources = [PROFILE.personal, PROFILE.intent,
      (PROFILE.education || [])[0], (PROFILE.languages || [])[0], PROFILE.skills];
    const suffixes = ['_三级', '_二级', '_带区号'];
    for (const src of sources) {
      if (!src) continue;
      for (const suf of suffixes) {
        const v = src[key + suf];
        if (typeof v === 'string' && v.trim()) return v;
      }
    }
    return null;
  }

  // Q10: 返回结构化结果 {ok, levels}，levels=实际点中的级数；调用方据此判标，不回读 DOM。
  // v3.1: 总预算 6s——级联打不开时快速放弃并标记手动，绝不阻塞后续字段填充
  async function fillCascader(el, value, key) {
    const deadline = Date.now() + 6000;
    // 候选值：原值 → profile 的 _三级/_二级 变体 → VALUE_HINTS
    const variants = [value];
    const v3 = key ? lookupVariantValue(key) : null;
    if (v3) variants.push(v3);
    let bestProgress = 0; // 点中了几级
    for (let vi = 0; vi < variants.length; vi++) {
      const parts = String(variants[vi]).split(/[-·>、\s]+/).filter(Boolean);
      if (parts.length < 2) continue;
      openTrigger(el);
      // 等菜单出现（最多 1.2s）
      for (let w = 0; w < 12; w++) {
        const menuVisible = querySelectorAllDeep(OPTION_SEL).some(o => isVisible(o) && !isInPanel(o));
        if (menuVisible) break;
        if (Date.now() > deadline) { closeDropdown(); return { ok: false, levels: bestProgress, expected: parts.length }; }
        await sleep(100);
      }
      const done = [];
      for (const part of parts) {
        let hit = null;
        // 选项未渲染时轮询（最多 1s，命中即走）
        for (let attempt = 0; attempt < 5 && !hit; attempt++) {
          hit = pickOption(part);
          if (!hit) await sleep(200);
        }
        if (!hit) break;
        done.push(part);
        // 每级选完后等下一级菜单渲染（最多 1s）
        for (let w = 0; w < 10; w++) {
          await sleep(100);
          const nextLevelVisible = querySelectorAllDeep(OPTION_SEL).some(o => isVisible(o) && !isInPanel(o));
          if (nextLevelVisible) break;
        }
        if (Date.now() > deadline) break;
      }
      closeDropdown();
      bestProgress = Math.max(bestProgress, done.length);
      // Q10: 只有当实际点中的级数 == 期望值级数，才算 ok
      if (done.length === parts.length) return { ok: true, levels: done.length, expected: parts.length };
      if (Date.now() > deadline) break;
    }
    // 单级兜底
    openTrigger(el);
    for (let w = 0; w < 12; w++) {
      const menuVisible = querySelectorAllDeep(OPTION_SEL).some(o => isVisible(o) && !isInPanel(o));
      if (menuVisible) break;
      if (Date.now() > deadline) { closeDropdown(); return { ok: false, levels: bestProgress, expected: 1 }; }
      await sleep(100);
    }
    let hit = null;
    for (let attempt = 0; attempt < 5 && !hit; attempt++) { hit = pickOption(value); if (!hit) await sleep(200); }
    closeDropdown();
    const singleOk = !!hit;
    return { ok: singleOk, levels: singleOk ? 1 : bestProgress, expected: 1 };
  }

  function fillNativeSelect(el, value) {
    const cands = [String(value)].concat(VALUE_HINTS[String(value)] || []);
    for (const c of cands) {
      const nc = norm(c);
      if (!nc) continue;
      const strict = nc.length <= 2;
      const opt = Array.from(el.options).find(o => {
        const t = norm(o.text), v = norm(o.value || '');
        if (!t && !v) return false;
        if (t === nc || v === nc) return true;
        if (strict) return false;
        return t.includes(nc) || v.includes(nc) || (nc.includes(t) && t.length >= 2);
      });
      if (opt) { setNativeValue(el, opt.value); return true; }
    }
    return false;
  }

  function fillDate(el, value, type) {
    const m = /^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?/.exec(String(value).trim());
    if (!m) return setNativeValue(el, String(value));
    const mm = String(m[2]).padStart(2, '0');
    const dd = m[3] ? String(m[3]).padStart(2, '0') : '01';
    const v = type === 'month' ? `${m[1]}-${mm}` : `${m[1]}-${mm}-${dd}`;
    return setNativeValue(el, v);
  }

  async function fillControl(cand, value, key) {
    if (cand.kind === 'group') return fillChoiceGroup(cand.group, value);
    const el = cand.el;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'select') return fillNativeSelect(el, value);
    if (type === 'date' || type === 'month') return fillDate(el, value, type);
    // 日期 picker（ant/arco）：直接键入
    if (/^\d{4}[-/年]\d{1,2}([-/月]\d{1,2}日?)?/.test(String(value).trim()) &&
      (el.closest && el.closest('.ant-picker,.arco-picker,.t-date-picker,.devui-date-picker,[class*="datepicker"],[class*="DatePicker"],[class*="date-picker"]'))) {
      el.focus();
      setNativeValue(el, String(value).replace(/[年月]/g, '-').replace(/日/g, ''));
      // Q9: 触发回车 + blur，让组件内部校验通过
      await sleep(120);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
      await sleep(120);
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      el.blur && el.blur();
      // 点击 body 触发 ant-picker 的确认
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, view: window }));
      document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, view: window }));
      return true;
    }
    if (isCustomDropdown(el)) {
      if (looksLikeCascader(el)) {
        const r = await fillCascader(el, value, key || null);
        // Q10: 结构化结果透传给 fillPairs 判标；这里原样返回
        return r;
      }
      return fillCustomDropdown(el, value);
    }
    // 普通输入
    try { el.focus(); } catch (e) { /* noop */ }
    setNativeValue(el, String(value));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  // ======================== 候选收集 + 标记（v3.1: Shadow DOM 穿透） ========================
  function collectCandidates() {
    const out = [];
    // Q4: 使用 querySelectorAllDeep 穿透 Shadow DOM
    querySelectorAllDeep(CONTROL_SEL).forEach(el => {
      if (!isVisibleDeep(el)) return;
      if (isInPanel(el)) return;
      if (el.type === 'radio' || el.type === 'checkbox') return;
      // P-B: 去重按属性分流（覆盖 ant/el/t-select/devui；不再是两个类名的硬编码特例）
      const CN = String(el.className || '');
      const innerCtl = el.querySelector ? el.querySelector(CONTROL_SEL) : null;
      // ① 外层是组件包裹层、内部有【可写】原生控件 → 跳过外层，交给内层
      if (innerCtl && innerCtl !== el && /select|cascader|picker|dropdown/i.test(CN) && !(innerCtl.readOnly || innerCtl.disabled)) return;
      // ② 只读/禁用的 input 位于选择器包裹层内 → 值只能由组件弹层决定，跳过该 input，交给外层点击路径
      if (el.tagName === 'INPUT' && (el.readOnly || el.disabled) && el.closest &&
          el.closest('.ant-select,.el-select,.t-select,.t-select__wrap,.devui-select,.devui-select__wrapper,.arco-select,.semi-select,.next-select,[role="combobox"]')) return;
      out.push({ kind: 'control', el, label: labelOf(el) });
    });
    collectChoiceGroups().forEach(g => {
      out.push({ kind: 'group', group: g, label: g.label, el: g.options[0] && g.options[0].input });
    });
    return out;
  }

  const marked = [];
  function markEl(el, color) {
    if (!el || !el.style) return;
    try {
      marked.push([el, el.style.outline, el.style.outlineOffset]);
      el.style.outline = '2px solid ' + color;
      el.style.outlineOffset = '1px';
    } catch (e) { /* noop */ }
  }
  const markOk = el => markEl(el, '#52c41a');
  const markManual = el => markEl(el, '#fa8c16');
  function clearMarks() {
    while (marked.length) {
      const [el, o, oo] = marked.pop();
      try { el.style.outline = o || ''; el.style.outlineOffset = oo || ''; } catch (e) { /* noop */ }
    }
  }

  // ======================== 填充逻辑 ========================
  const reports = [];
  let renderStatusFn = null;
  function log(msg) { reports.push(msg); if (renderStatusFn) renderStatusFn(); try { console.log('[秒填v3]', msg); } catch (e) { /* noop */ } }

  function entryToPairs(entry) {
    return Object.entries(entry || {})
      .filter(([k, v]) => !k.startsWith('_') && (typeof v === 'string' || typeof v === 'number') && String(v).trim() !== '')
      .map(([key, value]) => ({ key, value: String(value) }));
  }

  async function fillPairs(pairs, title) {
    const cands = collectCandidates();
    const matches = matchPairs(pairs, cands);
    const matchedPi = new Set(matches.map(m => m.pi));
    let ok = 0; const manual = [];
    for (let i = 0; i < pairs.length; i++) {
      if (!matchedPi.has(i)) manual.push('未找到:' + pairs[i].key);
    }
    for (const m of matches) {
      let done = false;
      let cascResult = null; // Q10: 级联结构化结果 {ok, levels, expected}
      try {
        const r = await fillControl(m.cand, m.pair.value, m.pair.key);
        if (r && typeof r === 'object' && 'ok' in r && 'levels' in r) {
          cascResult = r;
          done = !!r.ok;
        } else {
          done = !!r;
        }
        // 单选组 label 匹配失败时，用 name 属性兜底
        if (!done && m.cand.kind === 'group') {
          const nameMap = {
            '政治面貌': 'political', '性别': 'gender', '婚姻状况': 'marital',
            '民族': 'nation', '是否服从调配': 'obey', '是否接受调剂': 'adjust'
          };
          const name = nameMap[m.pair.key];
          if (name) {
            const g = findChoiceGroupByName(name);
            if (g) done = fillChoiceGroup(g, m.pair.value);
          }
        }
      } catch (e) {
        done = false;
        console.warn('[秒填助手] fillControl 异常:', m.pair.key, e.message);
      }
      // Q10: 级联用结构化结果判级数，不回读 DOM
      if (cascResult && m.cand.kind === 'control' && m.cand.el) {
        const el = m.cand.el;
        if (!cascResult.ok || cascResult.levels < cascResult.expected) {
          // 级联未填满期望级数 → 橙标
          markManual(el);
          manual.push('需手动:' + m.pair.key + '=' + m.pair.value);
          continue;
        }
      }
      if (done) { ok++; if (m.cand.el) markOk(m.cand.el); }
      else {
        manual.push('需手动:' + m.pair.key + '=' + m.pair.value);
        if (m.cand.el) markManual(m.cand.el);
      }
      await sleep(90);
    }
    log(`【${title}】填入 ${ok}/${pairs.length} 项` + (manual.length ? ` ｜ ${manual.join('；')}` : ''));
    if (manual.length) copyText(manual.join('\n'));
    return ok;
  }

  async function fillEntry(entry, title) { await fillPairs(entryToPairs(entry), title); }

  function flatBasicPairs() {
    const pairs = [];
    const pushObj = o => {
      if (!o) return;
      Object.entries(o).forEach(([k, v]) => {
        if (!k.startsWith('_') && (typeof v === 'string' || typeof v === 'number') && String(v).trim() !== '') pairs.push({ key: k, value: String(v) });
      });
    };
    pushObj(PROFILE.personal);
    pushObj(PROFILE.intent);
    if (PROFILE.education && PROFILE.education[0]) pushObj(PROFILE.education[0]);
    if (PROFILE.languages && PROFILE.languages[0]) pushObj(PROFILE.languages[0]);
    pushObj(PROFILE.skills);
    // 自我评价默认用通用版
    const se = PROFILE.self_eval;
    if (se) {
      const v = se['通用版'] || Object.values(se).find(x => typeof x === 'string' && x.length > 50);
      if (v) pairs.push({ key: '自我评价', value: v });
    }
    return pairs;
  }

  async function fillAll() {
    if (isSampleProfile()) {
      log('当前是示例资料。请先点击「编辑资料」，导入自己的 profile.json 并保存。');
      return;
    }
    clearMarks();
    await fillPairs(flatBasicPairs(), '一键填充');
    log('✅ 填充完成（绿=已填，橙=待手动，待手动值已复制到剪贴板）。请核对后手动提交。');
  }

  function previewMatch() {
    const pairs = flatBasicPairs();
    const cands = collectCandidates();
    const matches = matchPairs(pairs, cands);
    const matchedPi = new Set(matches.map(m => m.pi));
    const lines = matches.map(m => `✔ ${m.pair.key} → 「${(m.cand.label || '').slice(0, 24)}」(${m.score})`);
    const missing = pairs.filter((p, i) => !matchedPi.has(i)).map(p => `✘ ${p.key}（页面上没找到）`);
    log(['匹配预览：', ...lines, ...missing].join('\n'));
    copyText(lines.concat(missing).join('\n'));
  }

  function dumpFields() {
    const rows = collectCandidates().map(c => ({
      label: (c.label || '').slice(0, 50),
      kind: c.kind,
      tag: c.el ? c.el.tagName.toLowerCase() : '',
      type: (c.el && c.el.getAttribute && c.el.getAttribute('type')) || '',
      placeholder: (c.el && c.el.getAttribute && c.el.getAttribute('placeholder')) || '',
      value: (c.el && c.el.value || '').slice(0, 40)
    })).filter(r => r.label);
    const txt = JSON.stringify(rows, null, 1);
    copyText(txt);
    return txt;
  }

  function expandEditCards() {
    let n = 0;
    document.querySelectorAll('button, a, [role="button"], .btn, [class*="btn"], [class*="button"], [class*="edit"], [class*="modify"]').forEach(b => {
      if (n >= 20) return;
      if (!isVisible(b)) return;
      if (b.closest('#jlj-panel-host')) return;
      const t = (b.innerText || '').trim();
      if (/^(编辑|修改|完善|新增|添加|继续填写)$/.test(t)) {
        try { b.scrollIntoView({ block: 'center' }); b.click(); n++; } catch (e) { /* noop */ }
      }
    });
    log(`已点击 ${n} 个编辑/展开按钮，稍等 1-2 秒表单展开后再填充。`);
  }

  // ======================== 面板 UI（v3.1: CSP 回退 + 站点开关） ========================
  const host = document.createElement('div');
  host.id = 'jlj-panel-host';
  host.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;';

  // Q8: CSP 严格页面 attachShadow 失败时回退普通 div
  let shadow = null;
  try {
    shadow = host.attachShadow({ mode: 'open' });
  } catch (e) {
    shadow = host; // 退化：直接用 host 作为面板容器
  }

  // Q1: 站点启用开关（localStorage 记忆）
  const SITE_ENABLED_KEY = 'jlj_enabled_sites';
  function getEnabledSites() {
    try { return JSON.parse(localStorage.getItem(SITE_ENABLED_KEY) || '{}'); } catch (e) { return {}; }
  }
  function isCurrentSiteEnabled() {
    const sites = getEnabledSites();
    const host = location.hostname;
    // 默认启用，除非显式关闭
    return sites[host] !== false;
  }
  function toggleCurrentSite() {
    const sites = getEnabledSites();
    const host = location.hostname;
    sites[host] = !isCurrentSiteEnabled();
    localStorage.setItem(SITE_ENABLED_KEY, JSON.stringify(sites));
    return sites[host];
  }

  function collectTextBlocks() {
    const blocks = [];
    const add = (name, txt) => { if (typeof txt === 'string' && txt.length >= 40) blocks.push([name, txt]); };
    (PROFILE.internships || []).filter(e => !e['_不列入实习经历']).forEach((e, i) => {
      add('实习·' + (e.公司名称 || i) + '·职责', e.工作职责);
      add('实习·' + (e.公司名称 || i) + '职责(品牌岗)', e['工作职责_品牌岗版']);
    });
    (PROFILE.campus || []).forEach(e => add('校园·' + (e.组织名称 || '') + '·职责', e.职责描述));
    (PROFILE.projects || []).forEach(e => add('项目·' + (e.项目名称 || '') + '·概述', e.项目概述));
    const se = PROFILE.self_eval || {};
    Object.keys(se).filter(k => !k.startsWith('_') && k !== '_标题' && k !== '_字数参考').forEach(k => add('自我评价·' + k, se[k]));
    if (PROFILE.research) Object.entries(PROFILE.research).forEach(([k, v]) => { if (typeof v === 'string' && !k.startsWith('_')) add('科研·' + k, v); });
    return blocks.filter(b => b[1]);
  }

  // P-C: CSP 严格页面里 shadow 内的 <style> 会被拦（st.sheet === null）→ 改用 constructable stylesheet
  //      不复制 CSS 文本，直接从已写入的 <style> 取；正常环境 <style> 生效则不动
  function ensureStyles(root) {
    try {
      const st = root && root.querySelector ? root.querySelector('style') : null;
      if (!st) return false;
      if (st.sheet) return true;                       // 正常：<style> 生效
      if (root.adoptedStyleSheets && root.adoptedStyleSheets.length) return true;
      if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in root) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(st.textContent);
        root.adoptedStyleSheets = [sheet];
        console.log('[秒填助手 ' + VER + '] CSP 拦下了 <style>，已改用 CSSOM 注入面板样式。');
        return true;
      }
    } catch (e) { /* noop */ }
    return false;
  }

  function renderPanel() {
    shadow.innerHTML = `
  <style>
    .wrap{font:12px/1.5 "Microsoft YaHei",system-ui;color:#222;background:#fff;border:1px solid #d43f3a;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.22);width:310px;max-height:72vh;display:flex;flex-direction:column;overflow:hidden}
    .hd{background:#c9302c;color:#fff;padding:6px 10px;cursor:move;display:flex;align-items:center;justify-content:space-between;font-weight:700;user-select:none}
    .hd .mini{cursor:pointer;background:rgba(255,255,255,.2);border-radius:4px;padding:0 6px}
    .bd{padding:8px;overflow:auto}
    .sec{margin:0 0 7px}
    .sec b{display:block;font-size:11px;color:#8a1f1c;margin:0 0 3px}
    button{font:inherit;margin:0 4px 4px 0;padding:3px 7px;border:1px solid #ddd;border-radius:5px;background:#fafafa;cursor:pointer}
    button:hover{background:#f0f0f0}
    button.main{background:#c9302c;color:#fff;border-color:#c9302c;font-weight:700}
    button.ok{background:#eaf7ea;border-color:#9ecf9e}
    textarea{width:100%;height:90px;font:11px monospace;box-sizing:border-box;display:none}
    .st{white-space:pre-wrap;font-size:11px;color:#444;background:#f7f7f7;border-radius:5px;padding:4px;max-height:100px;overflow:auto;margin-top:4px}
    .note{font-size:10px;color:#999;margin-top:3px}
  </style>
  <div class="wrap">
    <div class="hd"><span>秒填助手 ${VER} · 只填不提交</span><span class="mini" id="mini">—</span></div>
    <div class="bd" id="bd">
      <div class="sec" style="display:flex;align-items:center;justify-content:space-between">
        <label style="font-size:11px;color:#8a1f1c;font-weight:700"><input type="checkbox" id="siteToggle" checked> 本站点启用</label>
        <span style="font-size:10px;color:#999" id="siteName"></span>
      </div>
      <div class="sec"><b>① 一键填充（基础+意向+教育+语言+技能+自评）</b>
        <button class="main" id="go">⚡ 一键填充</button>
        <button id="preview">匹配预览</button></div>
      <div class="sec"><b>② 实习经历（逐条）</b><span id="interns"></span></div>
      <div class="sec"><b>③ 校园经历（逐条）</b><span id="campus"></span></div>
      <div class="sec"><b>④ 项目经历（逐条）</b><span id="projects"></span></div>
      <div class="sec"><b>⑤ 获奖经历（逐条）</b><span id="awards"></span></div>
      <div class="sec"><b>⑥ 长文本（点击复制后粘贴）</b><span id="texts"></span></div>
      <div class="sec"><b>⑦ 工具</b>
        <button id="dump">抓取字段</button>
        <button id="expand">展开编辑卡片</button>
        <button id="clear">清除标记</button></div>
      <div class="sec"><b>⑧ 资料管理</b>
        <button id="edit">编辑资料</button>
        <button id="save">保存配置</button>
        <button id="reset">还原默认</button></div>
      <textarea id="json"></textarea>
      <div class="st" id="st"></div>
      <div class="note">下拉/单选/级联/日期自动尝试；失败项橙色描边且已复制到剪贴板。改资料：编辑→粘贴新 JSON→保存。绝不自动提交。</div>
    </div>
  </div>`;

    ensureStyles(shadow);   // P-C: 每次重绘后确保样式生效（正常环境直通）

    const $ = id => shadow.getElementById(id);

    (PROFILE.internships || []).filter(e => !e['_不列入实习经历']).forEach((e, i) => {
      const b = document.createElement('button');
      b.className = 'ok'; b.textContent = (e._label || '实习-' + (i + 1)).replace(/^实习-\d+\s*/, '');
      b.onclick = () => fillEntry(e, e._label || ('实习-' + (i + 1)));
      $('interns').appendChild(b);
    });
    (PROFILE.campus || []).forEach((e, i) => {
      const b = document.createElement('button');
      b.className = 'ok'; b.textContent = (e._label || '校园-' + (i + 1)).replace(/^校园-\d+\s*/, '');
      b.onclick = () => fillEntry(e, e._label || ('校园-' + (i + 1)));
      $('campus').appendChild(b);
    });
    (PROFILE.projects || []).forEach((e, i) => {
      const b = document.createElement('button');
      b.className = 'ok'; b.textContent = (e._label || '项目-' + (i + 1)).replace(/^项目-\d+\s*/, '');
      b.onclick = () => fillEntry(e, e._label || ('项目-' + (i + 1)));
      $('projects').appendChild(b);
    });
    (PROFILE.awards || []).forEach((e, i) => {
      const b = document.createElement('button');
      b.className = 'ok'; b.textContent = (e._label || '获奖-' + (i + 1)).replace(/^获奖-\d+\s*/, '');
      b.onclick = () => fillEntry(e, e._label || ('获奖-' + (i + 1)));
      $('awards').appendChild(b);
    });

    collectTextBlocks().forEach(([name, txt]) => {
      const b = document.createElement('button');
      b.textContent = name.length > 16 ? name.slice(0, 16) + '…' : name;
      b.title = name;
      b.onclick = () => { copyText(txt); log(`已复制「${name}」到剪贴板。`); };
      $('texts').appendChild(b);
    });

    renderStatusFn = () => { $('st').textContent = reports.slice(-8).join('\n'); };
    renderStatusFn();

    // Q1: 站点开关初始化
    const siteToggle = $('siteToggle');
    const siteName = $('siteName');
    if (siteToggle) {
      siteToggle.checked = isCurrentSiteEnabled();
      siteToggle.onchange = () => {
        const enabled = toggleCurrentSite();
        log(enabled ? `✅ 已在 ${location.hostname} 启用` : `⏸ 已在 ${location.hostname} 停用，刷新后生效`);
      };
    }
    if (siteName) siteName.textContent = location.hostname;

    const goButton = $('go');
    goButton.onclick = () => fillAll();
    if (isSampleProfile()) {
      goButton.textContent = '先替换示例资料';
      goButton.title = '点击「编辑资料」导入自己的 profile.json';
    }
    $('preview').onclick = () => previewMatch();
    $('dump').onclick = () => {
      const txt = dumpFields();
      const ta = $('json'); ta.style.display = 'block'; ta.value = txt;
      log('已抓取本页字段并复制（含标签/类型/单选组），可用于新增站点适配。');
    };
    $('expand').onclick = () => expandEditCards();
    $('clear').onclick = () => { clearMarks(); log('已清除页面标记。'); };
    $('edit').onclick = () => {
      const ta = $('json'); ta.style.display = 'block';
      ta.value = JSON.stringify(PROFILE, null, 1);
    };
    $('save').onclick = () => {
      const ta = $('json');
      if (ta.style.display === 'none' || !ta.value.trim()) { log('先点「编辑资料」或粘贴新 JSON 再保存。'); return; }
      try {
        PROFILE = JSON.parse(ta.value);
        // P-D: 存 GM 存储，不落 localStorage
        if (gmSet(LS_KEY, ta.value)) {
          log('✅ 配置已保存（Tampermonkey 安全存储），面板已按新资料刷新。');
        } else {
          log('⚠ 保存失败：请确认脚本 @grant 包含 GM_setValue。');
        }
        renderPanel();
      } catch (e) { log('❌ 保存失败：JSON 格式有误 → ' + e.message); }
    };
    $('reset').onclick = () => {
      gmDel(LS_KEY);
      PROFILE = JSON.parse(JSON.stringify(DEFAULT_PROFILE));
      renderPanel();
      log('已还原默认资料（profile.json 内置版）。');
    };
    $('mini').onclick = () => {
      const bd = $('bd');
      bd.style.display = bd.style.display === 'none' ? 'block' : 'none';
    };

    // 拖拽
    const hd = shadow.querySelector('.hd');
    let sx = 0, sy = 0, ox = 0, oy = 0, on = false;
    hd.addEventListener('pointerdown', e => {
      if (e.target.id === 'mini') return;
      on = true; sx = e.clientX; sy = e.clientY;
      const r = host.getBoundingClientRect(); ox = r.left; oy = r.top;
      hd.setPointerCapture(e.pointerId);
    });
    hd.addEventListener('pointermove', e => {
      if (!on) return;
      const nx = Math.max(4, Math.min(window.innerWidth - 60, ox + e.clientX - sx));
      const ny = Math.max(4, Math.min(window.innerHeight - 40, oy + e.clientY - sy));
      host.style.left = nx + 'px'; host.style.top = ny + 'px';
      host.style.right = 'auto'; host.style.bottom = 'auto';
    });
    hd.addEventListener('pointerup', () => { on = false; });
  }

  let frameRetry = 0;   // P-A: 帧内迟到表单的重试计数
  function mount() {
    if (document.getElementById('jlj-panel-host')) return;
    // Q1: 检查站点开关
    if (!isCurrentSiteEnabled()) {
      console.log('[秒填助手 ' + VER + '] 本站点已停用，面板不加载。');
      return;
    }
    // Q3/P-A: 帧内表单多是异步渲染的——首次没有控件时不再一次性放弃，改为限时轮询重试（60×500ms=30s）
    if (window.self !== window.top && !document.querySelector('input, select, textarea')) {
      if (frameRetry < 60) { frameRetry++; setTimeout(mount, 500); }
      return;
    }
    // Q8: documentElement 可能被替换，fallback 到 body
    try {
      (document.documentElement || document.body).appendChild(host);
    } catch (e) {
      document.body.appendChild(host);
    }
    renderPanel();
    console.log('[秒填助手 ' + VER + '] 已加载，面板在右下角。');
  }

  // Q2: SPA 路由切换监听 —— history.pushState / replaceState / popstate + MutationObserver
  let lastUrl = location.href;
  let observer = null;
  let rescanTimer = null;

  function onUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // 路由切换后延迟重挂面板 + 重新扫描
      setTimeout(() => {
        if (!document.getElementById('jlj-panel-host')) mount();
        log('检测到路由切换，已重新扫描表单控件。');
      }, 800);
    }
  }

  // 重写 history 方法监听 SPA 跳转
  try {
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;
    history.pushState = function() { origPushState.apply(this, arguments); onUrlChange(); };
    history.replaceState = function() { origReplaceState.apply(this, arguments); onUrlChange(); };
    window.addEventListener('popstate', onUrlChange);
    window.addEventListener('hashchange', onUrlChange);
  } catch (e) { /* noop */ }

  // Q2: MutationObserver 监听 DOM 变化，动态表单出现后自动重新扫描
  function setupObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      // 只在有表单相关节点加入时才触发
      const hasForm = mutations.some(m => {
        return Array.from(m.addedNodes).some(n => {
          if (!(n instanceof Element)) return false;
          // 忽略面板自身的渲染
          if (n.closest && n.closest('#jlj-panel-host')) return false;
          return n.matches && (n.matches(CONTROL_SEL) || n.querySelector && n.querySelector(CONTROL_SEL));
        });
      });
      if (hasForm) {
        // P-B: 动态表单出现——面板缺失就补挂（候选控件在点「一键填充」时实时采集，无需预先重扫）
        clearTimeout(rescanTimer);
        rescanTimer = setTimeout(() => {
          if (!document.getElementById('jlj-panel-host')) {
            mount();
            log('检测到动态表单渲染，已补挂面板。');
          }
        }, 800);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) { mount(); setupObserver(); }
  else window.addEventListener('DOMContentLoaded', () => { mount(); setupObserver(); });
})();
