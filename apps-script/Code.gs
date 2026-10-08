/**
 * 六甲頂匹克球分場系統 — Google 試算表後台
 *
 * 角色分工：
 *   這支程式只負責「存資料」與「產後台報表」。分場規則、賽程輪替、戰績計算全部留在
 *   網頁端（index.html）。原因是那套演算法有一百多行細節（性別名額、志願遞補、避免
 *   重複搭檔與重複對手、比分合法性），在兩個地方各維護一份一定會走鐘。網頁算完之後
 *   會把結果推到「分場結果／賽程／戰績」三張唯讀報表，所以你在試算表裡看到的東西
 *   一樣完整。
 *
 * 安裝：見同資料夾的「部署說明.md」。簡短版：
 *   1. 貼進 Apps Script 編輯器 → 存檔
 *   2. 執行一次 setup()
 *   3. 到「設定」工作表填管理密碼
 *   4. 部署成網頁應用程式（執行身分：我／存取權：任何人）
 *   5. 把 /exec 網址貼到 index.html 的 API_URL
 */

var VERSION = '1.2.0';

var TAB = {
  settings: '設定',
  players: '報名',
  scores: '比分',
  courts: '分場結果',
  sched: '賽程',
  rank: '戰績',
  log: '紀錄'
};

var HEAD = {};
HEAD[TAB.settings] = ['項目', '值', '說明'];
HEAD[TAB.players] = ['場次日期', 'id', '姓名', '性別', 'DUPR', '志願', '報名時間', '裝置代號'];
HEAD[TAB.scores] = ['場次日期', '場地', '對戰代號', 'A方得分', 'B方得分', '更新時間'];
HEAD[TAB.courts] = ['場次日期', '場地', '順位', '姓名', '性別', 'DUPR', '志願', '備註'];
HEAD[TAB.sched] = ['場次日期', '場地', '局', '時間', '搶分', 'A方', 'B方', 'A分', 'B分', '狀態'];
HEAD[TAB.rank] = ['場次日期', '場地', '名次', '單位', '勝', '敗', '得分', '失分', '淨分'];
HEAD[TAB.log] = ['時間', '動作', '場次', '內容', '結果'];

// 這些欄位一定要鎖成純文字：場次日期會被試算表自動吃成日期物件，對戰代號
// （例如 2026-10-02|1|12.15~3.9#1）長得像運算式，兩者被轉型後比分就對不上人了。
var TEXT_COLS = {};
TEXT_COLS[TAB.players] = [1];
TEXT_COLS[TAB.scores] = [1, 3];
TEXT_COLS[TAB.courts] = [1];
TEXT_COLS[TAB.sched] = [1];
TEXT_COLS[TAB.rank] = [1];

var SETTING_DEFAULTS = [
  ['管理密碼', '', '清空名單、刪別人、登錄比分、改首發日期時要輸入的密碼。請改成只有你知道的字串，留空的話這些動作會全部被拒絕。'],
  ['首發開打日期', '2026-10-02', 'YYYY-MM-DD。網頁的場次清單從這天之後的第一個週五起算 8 週。'],
  ['雙打場人數上限', 6, '1、2、3、5 號雙打場每場最多幾人，建議 4–8。（4 號主題場固定 8 人）'],
  ['雙打場局數', 8, '1、2、3、5 號場各排幾局。120 分鐘 ÷ 每局 15 分鐘 = 8。'],
  ['開放場地', '1,2,3,4,5', '這陣子有開的場地號碼，逗號分隔（例如 1,2,4）。關掉的場地網頁上不收報名、不排賽程，選了該場的球友會依 DUPR 改排到有開的場地。網頁管理選單的「開放場地」按鈕會自動改這一格。'],
  ['女雙PK場次', '', '第二週 4 號場女雙交流日採「玩法 B 閨蜜 PK 賽」的場次日期，多個用逗號分隔（例如 2026-10-09,2026-11-13）。沒列到的第二週一律是玩法 A 旋轉搭檔。網頁上的切換按鈕會自動改這一格。'],
  ['允許球友自行報名', 'TRUE', 'TRUE＝拿到連結的人可以自己報名。改成 FALSE 的話連報名都要管理密碼。'],
  ['紀錄保留筆數', 2000, '「紀錄」工作表超過這個筆數就會自動刪掉最舊的。'],
  ['試算表配色', 'light', 'light＝淺色（好讀、好印，推薦）；dark＝深色（跟網頁同一套顏色）。改完請執行選單「匹克球系統 → 重新套用美編」。']
];

// 改名過的設定：舊試算表裡還是舊名字，setup() 會把它們改成新名字（值保留）
var RENAMED_SETTINGS = [['A/B場人數上限', '雙打場人數上限'], ['A/B場局數', '雙打場局數']];

var LOG_CAP_FALLBACK = 2000;
var DUPR_MIN = 2, DUPR_MAX = 8;

/* ============================== 入口 ============================== */

/**
 * GET 主要給兩個用途：直接把網址貼到瀏覽器檢查有沒有部署成功，以及在 CORS 被
 * 擋掉的環境（某些 App 內建瀏覽器）用 JSONP 讀資料。
 */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var res = run(p.action || 'ping', p);
  if (p.callback) {
    return ContentService
      .createTextOutput(p.callback + '(' + JSON.stringify(res) + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return json(res);
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) {}
  return json(run(body.action || 'ping', body));
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// 會改資料的動作都要先搶鎖，否則兩個人同時報名會算出同一個 id。
var WRITE_ACTIONS = {
  signup: 1, withdraw: 1, setScore: 1, replaceRoster: 1,
  clearSession: 1, setSettings: 1, snapshot: 1
};

function run(action, p) {
  var lock = null;
  try {
    if (WRITE_ACTIONS[action]) {
      lock = LockService.getScriptLock();
      if (!lock.tryLock(20000)) throw new Error('另一個人正在寫入，請過幾秒再試一次');
    }
    switch (action) {
      case 'ping': return actionPing();
      case 'load': return actionLoad();
      case 'signup': return actionSignup(p);
      case 'withdraw': return actionWithdraw(p);
      case 'setScore': return actionSetScore(p);
      case 'replaceRoster': return actionReplaceRoster(p);
      case 'clearSession': return actionClearSession(p);
      case 'setSettings': return actionSetSettings(p);
      case 'snapshot': return actionSnapshot(p);
      default: throw new Error('不認識的動作：' + action);
    }
  } catch (err) {
    var msg = (err && err.message) || String(err);
    try { log('錯誤', (p && p.session) || '', action + '：' + msg, 'FAIL'); } catch (e2) {}
    return { ok: false, error: msg, version: VERSION };
  } finally {
    if (lock) lock.releaseLock();
  }
}

/* ============================== 動作 ============================== */

function actionPing() {
  var ss = book();
  return {
    ok: true, version: VERSION, action: 'ping',
    spreadsheet: ss.getName(),
    timeZone: ss.getSpreadsheetTimeZone(),
    serverTime: now(),
    hasPassword: !!String(getSetting('管理密碼') || ''),
    openSignup: isTrue(getSetting('允許球友自行報名')),
    tabs: Object.keys(HEAD).filter(function (t) { return !!ss.getSheetByName(t); })
  };
}

/** 一次把所有場次的名單與比分交給前端；前端自己決定要顯示哪一場。 */
function actionLoad() {
  var rosters = {}, scores = {};

  readRows(TAB.players).forEach(function (r) {
    var d = toIso(r[0]);
    if (!d) return;
    (rosters[d] = rosters[d] || []).push({
      id: num(r[1], 0),
      name: String(r[2] == null ? '' : r[2]).trim(),
      gender: String(r[3]).toUpperCase() === 'F' ? 'F' : 'M',
      dupr: clampDupr(num(r[4], DUPR_MIN)),
      pref: normPref(r[5]),
      device: String(r[7] == null ? '' : r[7])
    });
  });
  // 報名先後順序決定分場順位，所以不能靠列的順序（你在試算表裡排序過就會變）。
  // id 是單調遞增的，照 id 排等於照報名時間排，而且不怕手動排序。
  Object.keys(rosters).forEach(function (d) {
    rosters[d].sort(function (a, b) { return a.id - b.id; });
  });

  readRows(TAB.scores).forEach(function (r) {
    var key = String(r[2] == null ? '' : r[2]);
    if (!key) return;
    scores[key] = [cell(r[3]), cell(r[4])];
  });

  return {
    ok: true, action: 'load', full: true,
    startDate: toIso(getSetting('首發開打日期')) || '',
    capAB: num(settingAny('雙打場人數上限', 'A/B場人數上限'), 6),
    gamesAB: num(settingAny('雙打場局數', 'A/B場局數'), 8),
    pkDates: pkDates(),
    openCourts: openCourts(),
    openSignup: isTrue(getSetting('允許球友自行報名')),
    rosters: rosters, scores: scores, serverTime: now()
  };
}

function actionSignup(p) {
  var session = reqIso(p.session);
  if (!isTrue(getSetting('允許球友自行報名'))) requireAdmin(p);

  var name = String(p.name == null ? '' : p.name).trim();
  if (!name) throw new Error('請輸入姓名');
  if (name.length > 20) throw new Error('姓名請在 20 個字以內');

  var dupr = Number(p.dupr);
  if (!isFinite(dupr) || dupr < DUPR_MIN || dupr > DUPR_MAX) {
    throw new Error('DUPR 請輸入 ' + DUPR_MIN.toFixed(1) + '–' + DUPR_MAX.toFixed(1));
  }

  var rows = readRows(TAB.players);
  var clash = rows.some(function (r) {
    return toIso(r[0]) === session &&
      String(r[2] == null ? '' : r[2]).trim().toLowerCase() === name.toLowerCase();
  });
  if (clash) {
    throw new Error('這一場的名單上已經有「' + name + '」了。同名請加上區分（例如「' + name + '2」），避免分場時認錯人。');
  }

  // id 由伺服器集中發號，而且是從現有資料算出來的，所以不會因為誰的本機狀態
  // 落後而撞號（前端的 nextId 只在完全離線時才用得到）
  var id = nextId(rows);
  sheet(TAB.players).appendRow([
    session, id, name,
    String(p.gender).toUpperCase() === 'F' ? 'F' : 'M',
    Math.round(dupr * 10) / 10,
    normPref(p.pref), now(), String(p.device == null ? '' : p.device)
  ]);

  log('報名', session, name + '（' + (p.gender === 'F' ? '女' : '男') + ' ' + dupr + ' 志願' + normPref(p.pref) + '）', 'OK');
  return sessionState(session, { action: 'signup', id: id });
}

/**
 * 自己這支手機報的名，自己就能取消；要刪別人一律需要管理密碼。
 * 裝置代號只是「同一支手機」的憑據，不是身分認證——拿得到密碼才是真的管理權。
 */
function actionWithdraw(p) {
  var session = reqIso(p.session);
  var id = Number(p.id);
  if (!isFinite(id)) throw new Error('缺少要取消的報名 id');

  var sh = sheet(TAB.players), rows = readRows(TAB.players);
  var at = -1, row = null;
  for (var i = 0; i < rows.length; i++) {
    if (toIso(rows[i][0]) === session && num(rows[i][1], -1) === id) { at = i; row = rows[i]; break; }
  }
  if (at < 0) return sessionState(session, { action: 'withdraw', already: true });

  var device = String(p.device == null ? '' : p.device);
  var mine = !!device && String(row[7] == null ? '' : row[7]) === device;
  if (!mine) requireAdmin(p);

  sh.deleteRow(at + 2);
  log('取消報名', session, String(row[2]) + (mine ? '（本機報名）' : '（管理員）'), 'OK');
  return sessionState(session, { action: 'withdraw' });
}

function actionSetScore(p) {
  var session = reqIso(p.session);
  requireAdmin(p);

  var key = String(p.key == null ? '' : p.key);
  if (!key) throw new Error('缺少對戰代號');
  if (key.indexOf(session + '|') !== 0) throw new Error('對戰代號跟場次日期不符：' + key);

  var a = cell(p.a), b = cell(p.b);
  [a, b].forEach(function (v) {
    if (v !== '' && !/^\d{1,3}$/.test(v)) throw new Error('比分請填 0 以上的整數');
  });

  var sh = sheet(TAB.scores), rows = readRows(TAB.scores);
  var at = -1;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][2] == null ? '' : rows[i][2]) === key) { at = i; break; }
  }

  if (a === '' && b === '') {
    // 兩邊都清空就把整列刪掉，不要留一列空殼在試算表裡
    if (at >= 0) { sh.deleteRow(at + 2); log('清除比分', session, key, 'OK'); }
    return sessionState(session, { action: 'setScore' });
  }

  var court = String(p.court || key.split('|')[1] || '');
  var line = [session, court, key, a, b, now()];
  if (at >= 0) sh.getRange(at + 2, 1, 1, line.length).setValues([line]);
  else sh.appendRow(line);

  log('登錄比分', session, court + '場 ' + key.split('|').pop() + ' = ' + a + ':' + b, 'OK');
  return sessionState(session, { action: 'setScore' });
}

/**
 * 整批換掉某一場的名單。「載入範例」與「沿用上週名單」都走這裡。
 * id 一律重新發，伺服器才是唯一的發號來源。
 */
function actionReplaceRoster(p) {
  var session = reqIso(p.session);
  requireAdmin(p);

  var list = Array.isArray(p.players) ? p.players : [];
  if (list.length > 60) throw new Error('一場最多 60 人');

  var sh = sheet(TAB.players);
  deleteWhere(sh, function (r) { return toIso(r[0]) === session; });

  var rows = readRows(TAB.players);
  var id = nextId(rows);
  var seen = {}, lines = [];
  list.forEach(function (q) {
    var name = String(q && q.name != null ? q.name : '').trim();
    if (!name) return;
    var low = name.toLowerCase();
    if (seen[low]) return;              // 同一批裡的同名只留第一個
    seen[low] = 1;
    var dupr = clampDupr(num(q.dupr, DUPR_MIN));
    lines.push([
      session, id++, name,
      String(q.gender).toUpperCase() === 'F' ? 'F' : 'M',
      Math.round(dupr * 10) / 10, normPref(q.pref), now(),
      String(p.device == null ? '' : p.device)
    ]);
  });
  if (lines.length) sh.getRange(sh.getLastRow() + 1, 1, lines.length, lines[0].length).setValues(lines);

  log('整批換名單', session, lines.length + ' 人', 'OK');
  return sessionState(session, { action: 'replaceRoster' });
}

/** 只清掉這一場的名單、比分與快照，別場的資料不動。 */
function actionClearSession(p) {
  var session = reqIso(p.session);
  requireAdmin(p);

  var hit = function (r) { return toIso(r[0]) === session; };
  var removed = deleteWhere(sheet(TAB.players), hit);
  deleteWhere(sheet(TAB.scores), hit);
  [TAB.courts, TAB.sched, TAB.rank].forEach(function (t) { deleteWhere(sheet(t), hit); });

  log('清空場次', session, '刪掉 ' + removed + ' 位球友與該場比分', 'OK');
  return sessionState(session, { action: 'clearSession' });
}

function actionSetSettings(p) {
  requireAdmin(p);
  var changed = [];

  if (p.startDate != null) {
    var d = String(p.startDate);
    if (!isIsoDate(d)) throw new Error('首發開打日期要是 YYYY-MM-DD');
    setSetting('首發開打日期', d); changed.push('首發開打日期=' + d);
  }
  if (p.capAB != null) {
    var cap = num(p.capAB, 0);
    if (cap < 4 || cap > 8) throw new Error('雙打場人數上限請填 4–8');
    setSetting('雙打場人數上限', cap); changed.push('人數上限=' + cap);
  }
  if (p.gamesAB != null) {
    var g = num(p.gamesAB, 0);
    if (g < 4 || g > 16) throw new Error('雙打場局數請填 4–16');
    setSetting('雙打場局數', g); changed.push('局數=' + g);
  }
  if (p.openCourts != null) {
    var oc = (Array.isArray(p.openCourts) ? p.openCourts : []).map(function (c) { return String(c).trim(); });
    oc.forEach(function (c) { if (COURTS.indexOf(c) < 0) throw new Error('不認得的場地：' + c); });
    oc = COURTS.filter(function (c) { return oc.indexOf(c) >= 0; });
    if (!oc.length) throw new Error('至少要開放一面場地');
    setSetting('開放場地', oc.join(',')); changed.push('開放場地=' + oc.join(','));
  }
  if (p.pkDates != null) {
    var list = Array.isArray(p.pkDates) ? p.pkDates.map(String) : [];
    list.forEach(function (d) { if (!isIsoDate(d)) throw new Error('女雙PK場次要是 YYYY-MM-DD，收到的是：' + d); });
    list.sort();
    setSetting('女雙PK場次', list.join(',')); changed.push('女雙PK場次=' + (list.join(',') || '（無）'));
  }

  log('改設定', '', changed.join('、') || '（沒有變動）', 'OK');
  var res = actionLoad();
  res.action = 'setSettings';
  return res;
}

/**
 * 網頁算完的分場／賽程／戰績快照。這三張表是唯讀報表，每次推送都整場覆蓋，
 * 所以不要在上面手改東西。
 */
function actionSnapshot(p) {
  var session = reqIso(p.session);
  requireAdmin(p);

  var write = function (tab, lines) {
    var sh = sheet(tab);
    deleteWhere(sh, function (r) { return toIso(r[0]) === session; });
    if (lines.length) sh.getRange(sh.getLastRow() + 1, 1, lines.length, HEAD[tab].length).setValues(lines);
  };

  var courts = [], sched = [], rank = [];
  (Array.isArray(p.courts) ? p.courts : []).forEach(function (c) {
    (c.players || []).forEach(function (q, i) {
      courts.push([session, String(c.letter), i + 1, String(q.name), q.gender === 'F' ? '女' : '男',
        num(q.dupr, 0), labelPref(q.pref), String(q.note == null ? '' : q.note)]);
    });
  });
  (Array.isArray(p.sched) ? p.sched : []).forEach(function (m) {
    sched.push([session, String(m.court), num(m.no, 0), String(m.time), num(m.target, 0),
      String(m.a), String(m.b), cell(m.sa), cell(m.sb), String(m.state == null ? '' : m.state)]);
  });
  (Array.isArray(p.standings) ? p.standings : []).forEach(function (r) {
    rank.push([session, String(r.court), num(r.rank, 0), String(r.name),
      num(r.w, 0), num(r.l, 0), num(r.pf, 0), num(r.pa, 0), num(r.pf, 0) - num(r.pa, 0)]);
  });

  write(TAB.courts, courts);
  write(TAB.sched, sched);
  write(TAB.rank, rank);

  log('推送報表', session, '分場 ' + courts.length + ' 列、賽程 ' + sched.length + ' 列、戰績 ' + rank.length + ' 列', 'OK');
  return sessionState(session, { action: 'snapshot' });
}

/* ============================ 共用小工具 ============================ */

/** 每個會改資料的動作都回傳該場次「伺服器上的權威版本」，前端直接採用，id 才不會兩邊各編一套。 */
function sessionState(session, extra) {
  var roster = [], scores = {};
  readRows(TAB.players).forEach(function (r) {
    if (toIso(r[0]) !== session) return;
    roster.push({
      id: num(r[1], 0), name: String(r[2] == null ? '' : r[2]).trim(),
      gender: String(r[3]).toUpperCase() === 'F' ? 'F' : 'M',
      dupr: clampDupr(num(r[4], DUPR_MIN)), pref: normPref(r[5]),
      device: String(r[7] == null ? '' : r[7])
    });
  });
  roster.sort(function (a, b) { return a.id - b.id; });

  readRows(TAB.scores).forEach(function (r) {
    if (toIso(r[0]) !== session) return;
    var key = String(r[2] == null ? '' : r[2]);
    if (key) scores[key] = [cell(r[3]), cell(r[4])];
  });

  var out = { ok: true, session: session, roster: roster, scores: scores, serverTime: now() };
  for (var k in (extra || {})) out[k] = extra[k];
  return out;
}

function book() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet(name) {
  var sh = book().getSheetByName(name);
  if (!sh) throw new Error('找不到「' + name + '」工作表，請先在編輯器執行一次 setup()');
  return sh;
}

/** 回傳不含標題列的所有資料。空表回傳 []。 */
function readRows(name) {
  var sh = sheet(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, HEAD[name].length).getValues();
}

/** 由下往上刪，才不會刪一列之後把後面的列號全部位移。 */
function deleteWhere(sh, match) {
  var name = sh.getName();
  var rows = readRows(name), hits = [];
  for (var i = 0; i < rows.length; i++) if (match(rows[i])) hits.push(i + 2);
  for (var j = hits.length - 1; j >= 0; j--) sh.deleteRow(hits[j]);
  return hits.length;
}

function nextId(rows) {
  return rows.reduce(function (m, r) { var n = num(r[1], 0); return n > m ? n : m; }, 0) + 1;
}

var _settings = null;
function settingsMap() {
  if (_settings) return _settings;
  _settings = {};
  readRows(TAB.settings).forEach(function (r) {
    var k = String(r[0] == null ? '' : r[0]).trim();
    if (k) _settings[k] = r[1];
  });
  return _settings;
}
function getSetting(key) { var m = settingsMap(); return m.hasOwnProperty(key) ? m[key] : ''; }
/** 先找新名字，沒有（或空白）才找舊名字，還沒跑過新版 setup() 的試算表也讀得到 */
function settingAny(key, oldKey) {
  var v = getSetting(key);
  return (v === '' || v == null) ? getSetting(oldKey) : v;
}
/** 沒填或填壞（一個都認不得）時當成全開，不要讓網頁變成沒有場地 */
function openCourts() {
  var raw = String(getSetting('開放場地') == null ? '' : getSetting('開放場地'));
  var got = raw.split(/[,，、\s]+/).map(function (c) { return c.trim().replace(/號場?$/, ''); });
  var oc = COURTS.filter(function (c) { return got.indexOf(c) >= 0; });
  return oc.length ? oc : COURTS.slice();
}
function pkDates() {
  return String(getSetting('女雙PK場次') || '').split(/[,，\s]+/).map(function (d) { return toIso(d.trim()); })
    .filter(function (d) { return !!d; });
}
function setSetting(key, val) {
  var sh = sheet(TAB.settings), rows = readRows(TAB.settings);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === key) { sh.getRange(i + 2, 2).setValue(val); _settings = null; return; }
  }
  sh.appendRow([key, val, '']);
  _settings = null;
}

function requireAdmin(p) {
  var want = String(getSetting('管理密碼') || '');
  if (!want) throw new Error('「設定」工作表的管理密碼還是空的，所有管理動作都會被拒絕。請先填一組密碼。');
  if (String((p && p.token) == null ? '' : p.token) !== want) throw new Error('管理密碼不正確');
}

/**
 * 場次日期可能是字串，也可能被試算表轉成 Date 物件（欄位格式被改掉時）。
 * 兩種都要認得，否則比分會對不上場次。
 */
function toIso(v) {
  if (v == null || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    return Utilities.formatDate(v, book().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  return isIsoDate(s) ? s : '';
}

/** 格式對還不夠，還要真的是那一天：2026-02-30 會進位成 3/2，0099-01-01 會被當成 1999。 */
function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var p = s.split('-').map(Number);
  var d = new Date(p[0], p[1] - 1, p[2]);
  return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2];
}

function reqIso(v) {
  var s = toIso(v);
  if (!s) throw new Error('場次日期要是 YYYY-MM-DD，收到的是：' + JSON.stringify(v));
  return s;
}

// 舊版 A/B/C 三場：A＝極限挑戰（現 1 號）、B＝友善歡樂（現 2 號）、C＝主題（現 4 號）
var LEGACY_COURT = { A: '1', B: '2', C: '4' };
var COURTS = ['1', '2', '3', '4', '5'];
function normPref(v) {
  var s = String(v == null ? '' : v).trim().toUpperCase().replace(/號場?$/, '');
  if (LEGACY_COURT[s]) s = LEGACY_COURT[s];
  return COURTS.indexOf(s) >= 0 ? s : 'auto';
}
function labelPref(v) { var s = normPref(v); return s === 'auto' ? '自動' : s + '號場'; }
function clampDupr(n) { return Math.min(DUPR_MAX, Math.max(DUPR_MIN, isFinite(n) ? n : DUPR_MIN)); }
function num(v, dflt) { var n = Number(v); return isFinite(n) ? n : dflt; }
function cell(v) { return (v == null || v === '') ? '' : String(v).trim(); }
function isTrue(v) {
  var s = String(v == null ? '' : v).trim().toUpperCase();
  return s === 'TRUE' || s === '1' || s === 'YES' || s === 'Y' || s === '是';
}
function now() {
  return Utilities.formatDate(new Date(), book().getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

function log(action, session, detail, result) {
  var sh = book().getSheetByName(TAB.log);
  if (!sh) return;
  sh.appendRow([now(), action, session || '', detail || '', result || '']);
  var cap = num(getSetting('紀錄保留筆數'), LOG_CAP_FALLBACK);
  var extra = sh.getLastRow() - 1 - cap;
  if (extra > 0) sh.deleteRows(2, extra);
}

/* ============================== 美編 ==============================
   配色由「設定」工作表的「試算表配色」決定（light / dark），改完執行選單的
   「重新套用美編」即可。淺色是預設，因為 Google 試算表本身的工具列、列號、
   選取框都是亮的，整張弄成深色會打架，而且列印很吃墨。 */

var THEMES = {
  // 淺色：標題用網頁的深藍＋螢光綠維持品牌感，內容區留白好讀
  light: {
    headBg: '#0E1A2B', headFg: '#D7F54A', rule: '#D7F54A',
    bg: '#FFFFFF', fg: '#1B2430', muted: '#8894A5',
    stripe: '#F5F8FB', grid: '#E2E8F0', panel: '#F7FAFF',
    // 場地色比網頁深一點，白字才壓得住
    1: '#E8492A', 2: '#D97A00', 3: '#15A39C', 4: '#7C4DEF', 5: '#2E9E55', onCourt: '#FFFFFF',
    male: '#1F6FEB', female: '#D6336C',
    goodFg: '#11693F', goodBg: '#E8F6EE',
    badFg: '#B3261E', badBg: '#FCEBEA',
    warnFg: '#7A5B00', warnBg: '#FFF3D4',
    goldFg: '#6B5400', goldBg: '#FFF6D0'
  },
  // 深色：跟 index.html 同一組色票
  dark: {
    headBg: '#0A1422', headFg: '#D7F54A', rule: '#D7F54A',
    bg: '#0E1A2B', fg: '#F3F6FA', muted: '#7E8DA3',
    stripe: '#13223A', grid: '#1E3150', panel: '#16263D',
    1: '#FF5A36', 2: '#FF9F1C', 3: '#3FD0C9', 4: '#B98CFF', 5: '#5CD68A', onCourt: '#0E1A2B',
    male: '#7FB2FF', female: '#FF8FC0',
    goodFg: '#D7F54A', goodBg: '#1E2E16',
    badFg: '#FF8A70', badBg: '#2E1512',
    warnFg: '#FFD27A', warnBg: '#2A2112',
    goldFg: '#D7F54A', goldBg: '#33300F'
  }
};

function theme() {
  var name = String(getSetting('試算表配色') || 'light').trim().toLowerCase();
  return THEMES[name] || THEMES.light;
}

// 固定欄寬比 autoResizeColumns 好看：內容長短每週都在變，自動縮放會讓表格一直跳
var COL_W = {};
COL_W[TAB.settings] = [170, 230, 560];
COL_W[TAB.players] = [105, 46, 130, 56, 62, 62, 150, 120];
COL_W[TAB.scores] = [105, 56, 300, 78, 78, 150];
COL_W[TAB.courts] = [105, 56, 52, 130, 56, 62, 66, 200];
COL_W[TAB.sched] = [105, 56, 46, 66, 60, 190, 190, 60, 60, 130];
COL_W[TAB.rank] = [105, 56, 56, 190, 52, 52, 62, 62, 62];
COL_W[TAB.log] = [150, 110, 105, 460, 70];

var MONO = 'Courier New';
var PROTECT_TAG = '匹克球系統：報表由網頁推送，請勿手改';

/** 重新套用全部美編。可以重複執行，不會越疊越多。 */
function applyTheme() {
  var ss = book(), T = theme();

  Object.keys(HEAD).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    var head = HEAD[name], nc = head.length;
    ensureCols_(sh, nc);
    var rows = sh.getMaxRows();

    // --- 先清掉上一次留下的裝飾，否則每次執行都會多疊一層 ---
    sh.getBandings().forEach(function (b) { b.remove(); });
    sh.setConditionalFormatRules([]);
    sh.getRange(1, 1, rows, nc).clearDataValidations();

    // --- 版面 ---
    sh.setHiddenGridlines(true);           // 格線關掉，讓框線與斑馬紋自己說話
    sh.setFrozenRows(1);
    (COL_W[name] || []).forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
    if (nc < sh.getMaxColumns()) sh.hideColumns(nc + 1, sh.getMaxColumns() - nc);

    // --- 內容區底色 ---
    // 關掉格線之後刻意「不」畫內框線：框線會一路畫到第 1000 列，變成一大片空格子。
    // 列與列的區隔交給下面的斑馬紋，而斑馬紋只套用在有資料的列上。
    var body = sh.getRange(2, 1, rows - 1, nc);
    body.setBackground(T.bg).setFontColor(T.fg).setFontSize(10).setVerticalAlignment('middle');
    sh.setRowHeights(2, rows - 1, 26);

    // --- 標題列 ---
    sh.getRange(1, 1, 1, nc).setValues([head])
      .setBackground(T.headBg).setFontColor(T.headFg)
      .setFontWeight('bold').setFontSize(10)
      .setVerticalAlignment('middle').setHorizontalAlignment('left')
      .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP)
      .setBorder(null, null, true, null, false, false, T.rule, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
    sh.setRowHeight(1, 34);

    // --- 欄位格式：先鎖純文字，日期才不會被吃成 Date ---
    (TEXT_COLS[name] || []).forEach(function (col) {
      sh.getRange(1, col, rows).setNumberFormat('@');
    });

    var rules = [];
    var col = function (c) { return sh.getRange(2, c, rows - 1, 1); };
    var wholeRow = sh.getRange(2, 1, rows - 1, nc);

    if (name === TAB.settings) {
      col(1).setFontWeight('bold');
      col(2).setBackground(T.panel).setFontWeight('bold').setHorizontalAlignment('left');
      col(3).setFontColor(T.muted).setFontSize(9).setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
      sh.setRowHeights(2, rows - 1, 40);
      // 密碼沒填是最常見的卡關點，直接讓那一列變色提醒
      rules.push(SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=AND($A2="管理密碼",$B2="")')
        .setBackground(T.badBg).setFontColor(T.badFg).setBold(true)
        .setRanges([wholeRow]).build());
      dropdown_(sh, '允許球友自行報名', ['TRUE', 'FALSE']);
      dropdown_(sh, '試算表配色', ['light', 'dark']);
    }

    if (name === TAB.players) {
      sh.getRange(1, 5, rows).setNumberFormat('0.0');
      [2, 4, 5, 6].forEach(function (c) { col(c).setHorizontalAlignment('center'); });
      col(2).setFontColor(T.muted);
      col(3).setFontWeight('bold').setFontSize(11);
      col(7).setFontColor(T.muted).setFontSize(9);
      col(8).setFontFamily(MONO).setFontSize(8).setFontColor(T.muted)
        .setHorizontalAlignment('center');       // 裝置代號是內部欄位，壓低不要搶戲
      sh.getRange(2, 4, rows - 1, 1).setDataValidation(
        SpreadsheetApp.newDataValidation().requireValueInList(['M', 'F'], true).setAllowInvalid(true).build());
      sh.getRange(2, 6, rows - 1, 1).setDataValidation(
        SpreadsheetApp.newDataValidation().requireValueInList(['auto'].concat(COURTS), true).setAllowInvalid(true).build());
      genderRules_(rules, T, col(4));
      courtRules_(rules, T, col(6));
      // 3.0 以上才排得進 1 號場，標出來一眼就看得到
      rules.push(SpreadsheetApp.newConditionalFormatRule()
        .whenNumberGreaterThanOrEqualTo(3).setFontColor(T['1']).setBold(true)
        .setRanges([col(5)]).build());
    }

    if (name === TAB.scores) {
      col(2).setHorizontalAlignment('center').setFontWeight('bold');
      col(3).setFontFamily(MONO).setFontSize(9).setFontColor(T.muted);
      [4, 5].forEach(function (c) {
        col(c).setHorizontalAlignment('center').setFontWeight('bold').setFontSize(12);
      });
      col(6).setFontColor(T.muted).setFontSize(9);
      courtRules_(rules, T, col(2));
    }

    if (name === TAB.courts) {
      [2, 3, 5, 6, 7].forEach(function (c) { col(c).setHorizontalAlignment('center'); });
      col(2).setFontWeight('bold');
      col(3).setFontColor(T.muted);
      col(4).setFontWeight('bold').setFontSize(11);
      sh.getRange(1, 6, rows).setNumberFormat('0.0');
      col(8).setFontColor(T.warnFg).setFontSize(9).setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
      courtRules_(rules, T, col(2));
      genderRules_(rules, T, col(5));
    }

    if (name === TAB.sched) {
      [2, 3, 4, 5, 8, 9].forEach(function (c) { col(c).setHorizontalAlignment('center'); });
      col(2).setFontWeight('bold');
      col(3).setFontColor(T.muted);
      col(4).setFontFamily(MONO).setFontWeight('bold');
      col(5).setFontColor(T.muted);
      [6, 7].forEach(function (c) { col(c).setFontSize(11); });
      [8, 9].forEach(function (c) { col(c).setFontWeight('bold').setFontSize(12); });
      col(10).setHorizontalAlignment('center').setFontSize(9);
      courtRules_(rules, T, col(2));
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('完賽')
        .setBackground(T.goodBg).setFontColor(T.goodFg).setBold(true).setRanges([col(10)]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('未登錄')
        .setFontColor(T.muted).setRanges([col(10)]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('比分不合法')
        .setBackground(T.badBg).setFontColor(T.badFg).setBold(true).setRanges([col(10)]).build());
    }

    if (name === TAB.rank) {
      [2, 3, 5, 6, 7, 8, 9].forEach(function (c) { col(c).setHorizontalAlignment('center'); });
      col(2).setFontWeight('bold');
      col(4).setFontWeight('bold').setFontSize(11);
      sh.getRange(1, 9, rows).setNumberFormat('+0;-0;0');   // 淨分帶正負號才讀得快
      // 第 1 名整列鍍金。這條要放在場地色之前，名次才蓋得過場地色
      rules.push(SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=AND($A2<>"",$C2=1)')
        .setBackground(T.goldBg).setFontColor(T.goldFg).setBold(true)
        .setRanges([wholeRow]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0)
        .setFontColor(T.goodFg).setRanges([col(9)]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0)
        .setFontColor(T.badFg).setRanges([col(9)]).build());
      courtRules_(rules, T, col(2));
    }

    if (name === TAB.log) {
      body.setFontSize(9);
      col(1).setFontFamily(MONO).setFontColor(T.muted);
      col(2).setFontWeight('bold');
      col(4).setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP).setFontColor(T.muted);
      col(5).setHorizontalAlignment('center').setFontWeight('bold');
      sh.setRowHeights(2, rows - 1, 22);
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('FAIL')
        .setBackground(T.badBg).setFontColor(T.badFg).setRanges([col(5)]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('OK')
        .setFontColor(T.muted).setRanges([col(5)]).build());
    }

    // 斑馬紋放最後：條件式格式是「第一條命中的規則決定格式」，放前面會蓋掉上面那些
    // 專用規則。用公式而不是 applyRowBanding，條紋才會跟著資料長，不會鋪滿幾千列空白。
    if (name !== TAB.settings) {
      rules.push(SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=AND($A2<>"",MOD(ROW(),2)=0)')
        .setBackground(T.stripe).setRanges([wholeRow]).build());
    }
    sh.setConditionalFormatRules(rules);
  });

  // 分頁顏色：報名／比分是你要動的，報表是唯讀的，用顏色分群
  tabColor_(TAB.settings, T.muted);
  tabColor_(TAB.players, T.headFg);
  tabColor_(TAB.scores, T.headFg);
  tabColor_(TAB.courts, T['1']);
  tabColor_(TAB.sched, T['3']);
  tabColor_(TAB.rank, T['4']);
  tabColor_(TAB.log, T.grid);

  // 三張報表加「僅警告」的保護：手滑打字時會跳提醒，但不會真的鎖住你
  [TAB.courts, TAB.sched, TAB.rank].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) {
      if (p.getDescription() === PROTECT_TAG) p.remove();
    });
    sh.protect().setDescription(PROTECT_TAG).setWarningOnly(true);
    sh.getRange(1, 1).setNote('這張表由網頁的「推送分場／賽程／戰績到試算表」產生，每次推送會把這個場次整批覆蓋。請不要在這裡手改資料。');
  });
}

/** 欄位不夠就補。手動建過的工作表有可能欄數比標題少，那樣寫標題會直接失敗。 */
function ensureCols_(sh, n) {
  var have = sh.getMaxColumns();
  if (have < n) sh.insertColumnsAfter(have, n - have);
}

/** 把下拉選單套到「設定」表某一個項目的值欄上 */
function dropdown_(sh, key, options) {
  var rows = readRows(TAB.settings);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === key) {
      sh.getRange(i + 2, 2).setDataValidation(
        SpreadsheetApp.newDataValidation().requireValueInList(options, true).setAllowInvalid(true).build());
      return;
    }
  }
}

function genderRules_(rules, T, range) {
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('M')
    .setFontColor(T.male).setBold(true).setRanges([range]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('F')
    .setFontColor(T.female).setBold(true).setRanges([range]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('男')
    .setFontColor(T.male).setBold(true).setRanges([range]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('女')
    .setFontColor(T.female).setBold(true).setRanges([range]).build());
}

/**
 * 1–5 號場做成色塊，跟網頁上的場地顏色一致。場地欄寫進去的 '1' 常被試算表吃成數字，
 * 所以用 TO_TEXT 比對，數字和文字都認得；舊資料的 A/B/C 也照新場號上色。
 */
function courtRules_(rules, T, range) {
  var cell = '$' + String.fromCharCode(64 + range.getColumn()) + range.getRow();
  var paint = function (val, court) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=TO_TEXT(' + cell + ')="' + val + '"')
      .setBackground(T[court]).setFontColor(T.onCourt).setBold(true)
      .setRanges([range]).build());
  };
  COURTS.forEach(function (c) { paint(c, c); });
  Object.keys(LEGACY_COURT).forEach(function (c) { paint(c, LEGACY_COURT[c]); });
}

function tabColor_(name, color) {
  var sh = book().getSheetByName(name);
  if (sh) sh.setTabColor(color);
}

/* ============================ 安裝與選單 ============================ */

/** 執行一次就好；再執行也安全，只會補缺的東西、重新套用格式。 */
function setup() {
  var ss = book();

  // 1. 先把工作表與標題建好
  Object.keys(HEAD).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    ensureCols_(sh, HEAD[name].length);
    sh.getRange(1, 1, 1, HEAD[name].length).setValues([HEAD[name]]);
    // 先鎖純文字再寫任何資料，日期欄才不會被吃成 Date
    (TEXT_COLS[name] || []).forEach(function (c) { sh.getRange(1, c, sh.getMaxRows()).setNumberFormat('@'); });
  });

  // 2. 設定表只補不覆蓋，不要把使用者填好的密碼洗掉。改過名的設定先就地改名，值保留
  var setSh = sheet(TAB.settings);
  readRows(TAB.settings).forEach(function (r, i) {
    RENAMED_SETTINGS.forEach(function (pair) {
      if (String(r[0]).trim() === pair[0]) {
        var desc = SETTING_DEFAULTS.filter(function (d) { return d[0] === pair[1]; })[0];
        setSh.getRange(i + 2, 1).setValue(pair[1]);
        if (desc) setSh.getRange(i + 2, 3).setValue(desc[2]);
      }
    });
  });
  _settings = null;
  var have = {};
  readRows(TAB.settings).forEach(function (r) { have[String(r[0]).trim()] = 1; });
  var add = SETTING_DEFAULTS.filter(function (row) { return !have[row[0]]; });
  if (add.length) {
    var sh = sheet(TAB.settings);
    sh.getRange(sh.getLastRow() + 1, 1, add.length, 3).setValues(add);
    _settings = null;
  }

  // 3. 設定都在位了再套美編（配色與下拉選單都要讀設定表）
  applyTheme();
  ss.setActiveSheet(sheet(TAB.settings));

  log('初始化', '', '版本 ' + VERSION + '、配色 ' + String(getSetting('試算表配色') || 'light'), 'OK');
  alert_(
    '初始化完成（版本 ' + VERSION + '）\n\n' +
    '下一步：\n' +
    '1. 到「設定」工作表填入「管理密碼」\n' +
    '2. 部署 → 新增部署作業 → 網頁應用程式\n' +
    '   執行身分：我　／　誰可以存取：任何人\n' +
    '3. 把 /exec 結尾的網址貼到 index.html 的 API_URL'
  );
}

/** 從試算表選單執行就跳視窗；從 Apps Script 編輯器直接執行沒有 UI，改寫到執行記錄。 */
function alert_(msg) {
  try {
    SpreadsheetApp.getUi().alert(msg);
  } catch (e) {
    Logger.log(msg);
  }
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('匹克球系統')
    .addItem('初始化／重新套用格式', 'setup')
    .addItem('重新套用美編', 'menuApplyTheme')
    .addItem('切換深色／淺色配色', 'menuToggleTheme')
    .addSeparator()
    .addItem('產生一組新的管理密碼', 'menuNewPassword')
    .addItem('清空所有報表快照', 'menuClearSnapshots')
    .addItem('系統狀態', 'menuStatus')
    .addToUi();
}

function menuApplyTheme() {
  applyTheme();
  alert_('美編已重新套用（配色：' + String(getSetting('試算表配色') || 'light') + '）。');
}

function menuToggleTheme() {
  var next = String(getSetting('試算表配色') || 'light').trim().toLowerCase() === 'dark' ? 'light' : 'dark';
  setSetting('試算表配色', next);
  applyTheme();
  alert_('已切換成 ' + (next === 'dark' ? '深色（跟網頁同一套顏色）' : '淺色（好讀、好印）') + '。');
}

function menuNewPassword() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', pw = '';
  for (var i = 0; i < 10; i++) pw += chars.charAt(Math.floor(Math.random() * chars.length));
  setSetting('管理密碼', pw);
  alert_('新的管理密碼：\n\n' + pw + '\n\n已寫入「設定」工作表。原本已解鎖的手機下次操作時要重新輸入。');
}

function menuClearSnapshots() {
  var ui = SpreadsheetApp.getUi();
  var ans = ui.alert('清空報表快照', '會清掉「分場結果／賽程／戰績」三張表的全部內容（報名與比分不受影響）。要繼續嗎？', ui.ButtonSet.YES_NO);
  if (ans !== ui.Button.YES) return;
  [TAB.courts, TAB.sched, TAB.rank].forEach(function (t) {
    var sh = sheet(t);
    if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  });
  log('清空快照', '', '手動', 'OK');
  ui.alert('已清空。回網頁按「推送到試算表」就會重新產生。');
}

function menuStatus() {
  var s = actionPing();
  var counts = [TAB.players, TAB.scores, TAB.log].map(function (t) {
    return t + '：' + Math.max(0, sheet(t).getLastRow() - 1) + ' 筆';
  }).join('\n');
  alert_(
    '版本 ' + s.version + '\n時區 ' + s.timeZone + '\n' +
    '管理密碼：' + (s.hasPassword ? '已設定' : '⚠ 還沒設定，管理動作會全部被拒絕') + '\n' +
    '球友自行報名：' + (s.openSignup ? '開放' : '關閉（需密碼）') + '\n\n' + counts
  );
}
